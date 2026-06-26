/**
 * @file Unit tests for the `serverSignaling` adapter — envelope mapping, persistent session,
 * and WS lifecycle. All tests use a mock WebSocket; no real network.
 * @see ../../adapters/server.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serverSignaling } from "../../adapters/server";
import type { ClientEnvelope, ServerEnvelope, SignalMsg } from "../../protocol";

// ─────────────────────────────────────────────────────────────────────────────
// Mock WebSocket — uses addEventListener so the impl can use addEventListener.
// ─────────────────────────────────────────────────────────────────────────────

/** A controllable WebSocket double. Drive messages via `receiveFromServer`. */
class MockWebSocket {
  // eslint-disable-next-line sonarjs/public-static-readonly -- cleared via splice in beforeEach (readonly would prevent reassignment)
  static instances: MockWebSocket[] = [];

  readonly url: string;
  readyState: number = WebSocket.CONNECTING;
  readonly sentFrames: string[] = [];

  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  addEventListener(type: string, handler: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, handler: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      list.filter(h => h !== handler)
    );
  }

  private dispatch(type: string, event: unknown): void {
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }

  send(data: string): void {
    this.sentFrames.push(data);
  }

  close(code = 1000, reason = ""): void {
    this.readyState = WebSocket.CLOSING;
    queueMicrotask(() => {
      this.readyState = WebSocket.CLOSED;
      this.dispatch("close", { code, reason });
    });
  }

  /** Simulate the WS opening (transitions to OPEN and fires open listeners). */
  open(): void {
    this.readyState = WebSocket.OPEN;
    this.dispatch("open", {});
  }

  /** Deliver a serialized `ServerEnvelope` from the DO to this client session. */
  receiveFromServer(envelope: ServerEnvelope): void {
    this.dispatch("message", { data: JSON.stringify(envelope) });
  }

  /** Last envelope parsed from sent frames (the most recent client → server frame). */
  lastSent(): ClientEnvelope | null {
    const last = this.sentFrames.at(-1);
    return last ? (JSON.parse(last) as ClientEnvelope) : null;
  }
}

// Install the mock WebSocket globally before each test; restore after.
let originalWebSocket: typeof WebSocket | undefined;
beforeEach(() => {
  MockWebSocket.instances.splice(0);
  originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
});
afterEach(() => {
  if (originalWebSocket) globalThis.WebSocket = originalWebSocket;
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Opens a `serverSignaling` session: calls `join`, opens the WS, delivers `join-ack`,
 * and resolves once the returned promise settles.
 *
 * @param url - Base worker URL.
 * @param code - Room code.
 * @param selfId - Peer id for the join envelope.
 * @returns The session and the backing mock WS.
 * @example
 * ```ts
 * const { session, ws } = await openSession("wss://r.example.com", "K7M2QX", "host_root");
 * ```
 */
async function openSession(url = "wss://room.example.com", code = "K7M2QX", selfId = "host_root") {
  const sig = serverSignaling(url);
  const joinPromise = sig.join(code, { selfId });

  // The WS is created inside join(); find it.
  await vi.waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
  const ws = MockWebSocket.instances[0];
  if (!ws) throw new Error("expected a mock WS instance");

  // Simulate WS open → adapter sends {kind:"join"} → server replies join-ack.
  ws.open();
  ws.receiveFromServer({ kind: "join-ack", peers: [], reclaimToken: "tok123" });

  const session = await joinPromise;
  return { session, ws };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("serverSignaling — session.persistent", () => {
  it("returns a session with persistent: true", async () => {
    const { session } = await openSession();
    expect(session.persistent).toBe(true);
  });
});

describe("serverSignaling — join envelope", () => {
  it("sends a {kind:join} frame when the WS opens", async () => {
    const { ws } = await openSession("wss://r.example.com", "K7M2QX", "host_root");
    const join = ws.sentFrames[0] ? (JSON.parse(ws.sentFrames[0]) as ClientEnvelope) : null;
    expect(join).toMatchObject({ kind: "join", selfId: "host_root" });
  });

  it("opens the WS to the correct URL for the room code", async () => {
    await openSession("wss://r.example.com", "ABCD12", "host_root");
    const ws = MockWebSocket.instances[0];
    expect(ws?.url).toContain("ABCD12");
  });
});

describe("serverSignaling — peer-arrived → onPeer", () => {
  it("fires onPeer when the server sends peer-arrived", async () => {
    const { session, ws } = await openSession();
    const onPeer = vi.fn();
    session.onPeer(onPeer);

    ws.receiveFromServer({ kind: "peer-arrived", peerId: "p_ab12", role: "controller" });
    expect(onPeer).toHaveBeenCalledWith("p_ab12");
  });

  it("peers from join-ack are delivered via onPeer", async () => {
    const sig = serverSignaling("wss://r.example.com");
    const joinPromise = sig.join("K7M2QX", { selfId: "host_root" });

    await vi.waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws = MockWebSocket.instances[0];
    if (!ws) throw new Error("missing ws");

    ws.open();
    // Send join-ack with a pre-existing peer.
    ws.receiveFromServer({ kind: "join-ack", peers: ["p_existing"], reclaimToken: "tok" });
    const session = await joinPromise;

    const onPeer = vi.fn();
    session.onPeer(onPeer);
    // join-ack peers are queued and delivered when onPeer is registered.
    expect(onPeer).toHaveBeenCalledWith("p_existing");
  });
});

describe("serverSignaling — peer-left → onPeerLeave", () => {
  it("fires onPeerLeave when the server sends peer-left", async () => {
    const { session, ws } = await openSession();
    const onPeerLeave = vi.fn();
    session.onPeerLeave(onPeerLeave);

    ws.receiveFromServer({ kind: "peer-left", peerId: "p_ab12" });
    expect(onPeerLeave).toHaveBeenCalledWith("p_ab12");
  });
});

describe("serverSignaling — relay → onSignal", () => {
  it("fires onSignal when the server sends relay", async () => {
    const { session, ws } = await openSession();
    const onSignal = vi.fn();
    session.onSignal(onSignal);

    const msg: SignalMsg = { kind: "offer", sdp: "v=0...offer" };
    ws.receiveFromServer({ kind: "relay", from: "p_ab12", msg });

    expect(onSignal).toHaveBeenCalledWith("p_ab12", msg);
  });

  it("maps relay with a candidate SignalMsg", async () => {
    const { session, ws } = await openSession();
    const onSignal = vi.fn();
    session.onSignal(onSignal);

    const msg: SignalMsg = {
      kind: "candidate",
      candidate: { candidate: "candidate:1", sdpMid: "0", sdpMLineIndex: 0 }
    };
    ws.receiveFromServer({ kind: "relay", from: "p_ab12", msg });

    expect(onSignal).toHaveBeenCalledWith("p_ab12", msg);
  });
});

describe("serverSignaling — send → relay-out frame", () => {
  it("sends a {kind:relay, to, msg} envelope on session.send", async () => {
    const { session, ws } = await openSession();
    const offer: SignalMsg = { kind: "offer", sdp: "v=0...offer" };
    session.send("p_ab12", offer);

    const frame = ws.lastSent();
    expect(frame).toEqual({ kind: "relay", to: "p_ab12", msg: offer });
  });
});

describe("serverSignaling — evict → onEvict", () => {
  it("fires the onEvict callback when the server sends evict", async () => {
    const { session, ws } = await openSession();
    const onEvict = vi.fn();
    session.onEvict?.(onEvict);

    ws.receiveFromServer({ kind: "evict" });
    expect(onEvict).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when no onEvict is registered", async () => {
    const { ws } = await openSession();
    // Must not throw even without an evict handler registered.
    expect(() => ws.receiveFromServer({ kind: "evict" })).not.toThrow();
  });
});

describe("serverSignaling — reclaim (host reload)", () => {
  it("sends a {kind:reclaim} frame (not join) when opts.reclaimToken is set", async () => {
    const sig = serverSignaling("wss://r.example.com");
    const joinPromise = sig.join("K7M2QX", { selfId: "host_v2", reclaimToken: "tok-T" });

    await vi.waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws = MockWebSocket.instances[0];
    if (!ws) throw new Error("missing ws");
    ws.open();

    const sent = ws.sentFrames[0] ? (JSON.parse(ws.sentFrames[0]) as ClientEnvelope) : null;
    expect(sent).toEqual({ kind: "reclaim", selfId: "host_v2", reclaimToken: "tok-T" });

    // The DO acknowledges the reclaim; the session resolves with the presented token preserved.
    ws.receiveFromServer({ kind: "reclaim-ack", peers: ["p_ab12"] });
    const session = await joinPromise;
    expect(session.reclaimToken).toBe("tok-T");
  });

  it("exposes the DO-issued reclaimToken from join-ack on the session", async () => {
    const { session } = await openSession(); // openSession delivers join-ack reclaimToken "tok123"
    expect(session.reclaimToken).toBe("tok123");
  });

  it("queues reclaim-ack peers for onPeer so the host re-offers", async () => {
    const sig = serverSignaling("wss://r.example.com");
    const joinPromise = sig.join("K7M2QX", { selfId: "host_v2", reclaimToken: "tok-T" });

    await vi.waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws = MockWebSocket.instances[0];
    if (!ws) throw new Error("missing ws");
    ws.open();
    ws.receiveFromServer({ kind: "reclaim-ack", peers: ["p_ab12"] });
    const session = await joinPromise;

    const onPeer = vi.fn();
    session.onPeer(onPeer);
    expect(onPeer).toHaveBeenCalledWith("p_ab12");
  });
});

describe("serverSignaling — leave → ws.close(1000)", () => {
  it("closes the WS with code 1000 on leave()", async () => {
    const { session, ws } = await openSession();
    const closeSpy = vi.spyOn(ws, "close");
    await session.leave();
    expect(closeSpy).toHaveBeenCalledWith(1000, expect.any(String));
  });

  it("leave() resolves (does not throw)", async () => {
    const { session } = await openSession();
    await expect(session.leave()).resolves.toBeUndefined();
  });
});

describe("serverSignaling — lazy load (factory is thin)", () => {
  it("serverSignaling(url) returns a Signaling object synchronously without opening a WS", () => {
    // The factory itself must be thin — no WS created until join() is called.
    const sig = serverSignaling("wss://lazy.example.com");
    expect(sig).toBeDefined();
    expect(typeof sig.join).toBe("function");
    // No WS created yet.
    expect(MockWebSocket.instances).toHaveLength(0);
  });
});
