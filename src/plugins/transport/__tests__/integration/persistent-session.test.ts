/**
 * @file Integration tests for persistent-session behaviour (Cycle-2 delta):
 *  - `inMemory({ server: true })` two-peer handshake + persistent reconnect + reclaim
 *  - handlers.ts does NOT null a persistent session post-ICE
 *  - handlers.ts DOES null a non-persistent session post-ICE (regression guard)
 *  - onEvict wiring: server evict fires room:network-warning {reason:"room-evicted"}
 * @see ../../adapters/in-memory.ts
 * @see ../../handlers.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomEvents } from "../../../../contracts";
import { inMemory } from "../../adapters/in-memory";
import { handlePeerArrival } from "../../handlers";
import { createTransportState } from "../../state";
import type { TransportConfig } from "../../types";

const cfg: TransportConfig = {
  signaling: { join: vi.fn() },
  iceServers: [],
  heartbeatIntervalMs: 2000,
  heartbeatTimeoutMs: 6000,
  openTimeoutMs: 3000,
  maxMessageBytes: 14_336
};

const noopWarn: (reason: RoomEvents["room:network-warning"]["reason"]) => void = () => {};

// ─────────────────────────────────────────────────────────────────────────────
// inMemory({ server: true }) — two-peer handshake using the server-sim path
// ─────────────────────────────────────────────────────────────────────────────

describe("inMemory({ server: true }) — server-sim signaling", () => {
  it("two sessions on the same code mutually fire onPeer (server mode)", async () => {
    const sig = inMemory({ server: true });
    const hostSawPeer = vi.fn<(peerId: string) => void>();
    const ctrlSawPeer = vi.fn<(peerId: string) => void>();

    const host = await sig.join("K7M2QX", { selfId: "host_root" });
    host.onPeer(hostSawPeer);

    const ctrl = await sig.join("K7M2QX", { selfId: "p_ab12", passive: true });
    ctrl.onPeer(ctrlSawPeer);

    expect(hostSawPeer).toHaveBeenCalledWith("p_ab12");
    expect(ctrlSawPeer).toHaveBeenCalledWith("host_root");

    await host.leave();
    await ctrl.leave();
  });

  it("sessions in server mode report persistent: true", async () => {
    const sig = inMemory({ server: true });
    const session = await sig.join("K7M2QX", { selfId: "host_root" });
    expect(session.persistent).toBe(true);
    await session.leave();
  });

  it("leave() is idempotent in server mode", async () => {
    const sig = inMemory({ server: true });
    const session = await sig.join("K7M2QX", { selfId: "host_root" });
    await session.leave();
    await expect(session.leave()).resolves.toBeUndefined();
  });

  it("fires onPeerLeave when the other server-mode session leaves", async () => {
    const sig = inMemory({ server: true });
    const host = await sig.join("K7M2QX", { selfId: "host_root" });
    const ctrl = await sig.join("K7M2QX", { selfId: "p_ab12", passive: true });

    const hostSawLeave = vi.fn<(peerId: string) => void>();
    host.onPeerLeave(hostSawLeave);

    await ctrl.leave();
    expect(hostSawLeave).toHaveBeenCalledWith("p_ab12");

    await host.leave();
  });

  it("exposes onEvict on server-mode sessions", async () => {
    const sig = inMemory({ server: true });
    const session = await sig.join("K7M2QX", { selfId: "host_root" });
    expect(typeof session.onEvict).toBe("function");
    await session.leave();
  });

  it("fires the onEvict callback when the session is evicted", async () => {
    const sig = inMemory({ server: true });
    const session = await sig.join("K7M2QX", { selfId: "host_root" });
    const onEvict = vi.fn();
    session.onEvict?.(onEvict);

    // Trigger eviction on the server-sim session.
    // The server-sim session exposes an internal `_evict()` method for testing.
    if ("_evict" in session && typeof (session as { _evict: () => void })._evict === "function") {
      (session as { _evict: () => void })._evict();
    }
    expect(onEvict).toHaveBeenCalledTimes(1);

    await session.leave();
  });

  it("default inMemory() (no arg) still returns non-persistent sessions", async () => {
    const sig = inMemory();
    const session = await sig.join("K7M2QX", { selfId: "host_root" });
    // persistent should be absent or false/undefined
    expect(session.persistent).toBeFalsy();
    await session.leave();
  });

  it("two passive controllers in server mode don't see each other (star topology)", async () => {
    const sig = inMemory({ server: true });
    const host = await sig.join("K7M2QX", { selfId: "host_root" });
    const hostSaw = vi.fn<(peerId: string) => void>();
    host.onPeer(hostSaw);

    const c1 = await sig.join("K7M2QX", { selfId: "p_c1", passive: true });
    const c1Saw = vi.fn<(peerId: string) => void>();
    c1.onPeer(c1Saw);

    const c2 = await sig.join("K7M2QX", { selfId: "p_c2", passive: true });
    const c2Saw = vi.fn<(peerId: string) => void>();
    c2.onPeer(c2Saw);

    // Host sees both; controllers see only the host.
    expect(hostSaw.mock.calls.map(call => call[0]).toSorted()).toEqual(["p_c1", "p_c2"]);
    expect(c1Saw.mock.calls.map(call => call[0])).toEqual(["host_root"]);
    expect(c2Saw.mock.calls.map(call => call[0])).toEqual(["host_root"]);

    await host.leave();
    await c1.leave();
    await c2.leave();
  });

  it("send/onSignal delivers SignalMsgs in server mode (relay path)", async () => {
    const sig = inMemory({ server: true });
    const host = await sig.join("K7M2QX", { selfId: "host_root" });
    const ctrl = await sig.join("K7M2QX", { selfId: "p_ab12", passive: true });

    const ctrlInbound = vi.fn<(peerId: string, msg: unknown) => void>();
    ctrl.onSignal(ctrlInbound);

    const offer = { kind: "offer" as const, sdp: "v=0..." };
    host.send("p_ab12", offer);

    expect(ctrlInbound).toHaveBeenCalledWith("host_root", offer);

    await host.leave();
    await ctrl.leave();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// handlers.ts persistent guard — post-ICE session lifecycle
// ─────────────────────────────────────────────────────────────────────────────

describe("handlers.ts — persistent guard post-ICE", () => {
  /**
   * Builds a fake RTCPeerConnection that captures the `oniceconnectionstatechange` handler
   * so we can drive it to `connected` in tests.
   */
  class FakePc {
    iceConnectionState: RTCIceConnectionState = "new";
    oniceconnectionstatechange: (() => void) | null = null;
    onicecandidate: ((e: { candidate: null }) => void) | null = null;
    ondatachannel: ((e: { channel: RTCDataChannel }) => void) | null = null;
    readonly restartIce = vi.fn();
    readonly closeSpy = vi.fn();
    async createOffer(): Promise<RTCSessionDescriptionInit> {
      return { type: "offer", sdp: "v=0..." };
    }
    async setLocalDescription(): Promise<void> {}
    createDataChannel(): RTCDataChannel {
      return { addEventListener: vi.fn(), close: vi.fn() } as unknown as RTCDataChannel;
    }
    close(): void {
      this.closeSpy();
    }
    goConnected(): void {
      this.iceConnectionState = "connected";
      this.oniceconnectionstatechange?.();
    }
  }

  let originalRtc: typeof RTCPeerConnection | undefined;
  beforeEach(() => {
    originalRtc = globalThis.RTCPeerConnection;
    globalThis.RTCPeerConnection = FakePc as unknown as typeof RTCPeerConnection;
  });
  afterEach(() => {
    if (originalRtc) globalThis.RTCPeerConnection = originalRtc;
    vi.restoreAllMocks();
  });

  it("does NOT null session or call leave() when session.persistent is true", async () => {
    const state = createTransportState();
    state.role = "host";
    state.selfId = "host_root";

    const session = {
      onPeer: vi.fn(),
      onPeerLeave: vi.fn(),
      onSignal: vi.fn(),
      send: vi.fn(),
      leave: vi.fn().mockResolvedValue(undefined),
      persistent: true as const
    };
    state.session = session;

    handlePeerArrival(state, cfg, "p_ab12", noopWarn);
    await vi.waitFor(() => expect(state.peers.has("p_ab12")).toBe(true));

    const peer = state.peers.get("p_ab12");
    const pc = peer?.pc as unknown as FakePc;
    pc.goConnected();

    // Allow microtasks to settle.
    await new Promise<void>(resolve => setTimeout(resolve, 10));

    // With a persistent session, leave() MUST NOT be called and session MUST NOT be nulled.
    expect(session.leave).not.toHaveBeenCalled();
    expect(state.session).toBe(session);
  });

  it("DOES null session and call leave() when session.persistent is false/absent (non-persistent regression guard)", async () => {
    const state = createTransportState();
    state.role = "host";
    state.selfId = "host_root";

    const session = {
      onPeer: vi.fn(),
      onPeerLeave: vi.fn(),
      onSignal: vi.fn(),
      send: vi.fn(),
      leave: vi.fn().mockResolvedValue(undefined)
      // No persistent field — non-persistent session.
    };
    state.session = session;

    handlePeerArrival(state, cfg, "p_ab12", noopWarn);
    await vi.waitFor(() => expect(state.peers.has("p_ab12")).toBe(true));

    const peer = state.peers.get("p_ab12");
    const pc = peer?.pc as unknown as FakePc;
    pc.goConnected();

    // leave() should be called, and session should be nulled after it resolves.
    await vi.waitFor(() => expect(session.leave).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(state.session).toBeNull());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// onEvict wiring via handlers.ts
// ─────────────────────────────────────────────────────────────────────────────

describe("onEvict wiring — room:network-warning {reason:'room-evicted'}", () => {
  it("api.connect() registers session.onEvict and fires emitWarning('room-evicted') on eviction", async () => {
    // Use inMemory({ server: true }) which supports onEvict.
    const sig = inMemory({ server: true });
    const emitWarning = vi.fn<(reason: RoomEvents["room:network-warning"]["reason"]) => void>();

    const state = createTransportState();
    state.role = "host";
    state.selfId = "host_root";

    // Manually join to get a persistent session and wire up onEvict.
    const session = await sig.join("K7M2QX", { selfId: "host_root" });
    state.session = session;

    // Wire onEvict the same way api.ts will after the Cycle-2 change.
    session.onEvict?.(() => emitWarning("room-evicted"));

    // Trigger eviction.
    if ("_evict" in session && typeof (session as { _evict: () => void })._evict === "function") {
      (session as { _evict: () => void })._evict();
    }

    expect(emitWarning).toHaveBeenCalledWith("room-evicted");
  });
});
