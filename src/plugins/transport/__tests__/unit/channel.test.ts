/**
 * @file Unit tests for chunking/reassembly, backpressure, and the heartbeat.
 * @see ../../channel.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bindPeerChannel,
  createWire,
  disconnectPeer,
  startHeartbeat,
  tearDownState
} from "../../channel";
import type { Frame, PeerId } from "../../protocol";
import { createTransportState } from "../../state";
import type { PeerConnection, TransportConfig, TransportState } from "../../types";

// ─────────────────────────────────────────────────────────────────────────────
// Test doubles — a minimal RTCDataChannel stand-in capturing sent payloads and
// driving the `bufferedamountlow` event used by backpressure.
// ─────────────────────────────────────────────────────────────────────────────

type Listener = (event: Event) => void;

class FakeDataChannel {
  readyState: RTCDataChannelState = "open";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  readonly sent: string[] = [];
  readonly closed = vi.fn();
  private readonly listeners = new Map<string, Set<Listener>>();

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = "closed";
    this.closed();
  }

  addEventListener(type: string, cb: Listener): void {
    const set = this.listeners.get(type) ?? new Set<Listener>();
    set.add(cb);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, cb: Listener): void {
    this.listeners.get(type)?.delete(cb);
  }

  /** Fire `bufferedamountlow` to simulate the channel draining. */
  fireBufferedAmountLow(): void {
    this.bufferedAmount = 0;
    for (const cb of this.listeners.get("bufferedamountlow") ?? []) {
      cb(new Event("bufferedamountlow"));
    }
  }

  /** Deliver an inbound message to the channel's onmessage handler. */
  deliver(data: string): void {
    this.onmessage?.({ data } as MessageEvent);
  }

  onmessage: ((event: MessageEvent) => void) | null = null;
}

class FakePeerConnection {
  readonly closed = vi.fn();
  close(): void {
    this.closed();
  }
}

const cfg: TransportConfig = {
  signaling: { join: vi.fn() },
  iceServers: [],
  heartbeatIntervalMs: 2000,
  heartbeatTimeoutMs: 6000,
  openTimeoutMs: 3000,
  maxMessageBytes: 14_336
};

/** Build a connected peer record wired to a fresh fake channel. */
function addConnectedPeer(state: TransportState, peerId: PeerId): FakeDataChannel {
  const channel = new FakeDataChannel();
  const peer: PeerConnection = {
    peerId,
    pc: new FakePeerConnection() as unknown as RTCPeerConnection,
    channel: channel as unknown as RTCDataChannel,
    state: "connected",
    lastPongAt: Date.now(),
    paused: false,
    reassembly: new Map(),
    openTimer: null,
    retries: 0
  };
  state.peers.set(peerId, peer);
  return channel;
}

describe("channel — chunking", () => {
  it("a Frame just under maxMessageBytes serializes to a single un-enveloped message", () => {
    const state = createTransportState();
    state.role = "host";
    const channel = addConnectedPeer(state, "p1");
    const wire = createWire(state, cfg);

    const frame: Frame = { t: "intent", name: "move", payload: { x: 1 }, cSeq: 1 };
    wire.send("p1", frame);

    expect(channel.sent).toHaveLength(1);
    // A single un-enveloped frame parses straight back to the Frame.
    expect(JSON.parse(channel.sent[0] as string)).toEqual(frame);
  });

  it("a Frame just over maxMessageBytes serializes to N (>1) chunks", () => {
    const smallCfg: TransportConfig = { ...cfg, maxMessageBytes: 256 };
    const state = createTransportState();
    state.role = "host";
    const channel = addConnectedPeer(state, "p1");
    const wire = createWire(state, smallCfg);

    const big = "x".repeat(2000);
    const frame: Frame = {
      t: "sync-snap",
      snapshot: { board: { blob: big } },
      sSeq: 0
    };
    wire.send("p1", frame);

    expect(channel.sent.length).toBeGreaterThan(1);
    // Every emitted message is a chunk envelope with a shared id + a total.
    const envelopes = channel.sent.map(s => JSON.parse(s) as Record<string, unknown>);
    const ids = new Set(envelopes.map(e => e["id"]));
    expect(ids.size).toBe(1);
    expect(envelopes.every(e => e["total"] === channel.sent.length)).toBe(true);
  });

  it("N chunks reassemble byte-identically to the original Frame on the receiver", () => {
    const smallCfg: TransportConfig = { ...cfg, maxMessageBytes: 256 };

    // Sender state.
    const sender = createTransportState();
    sender.role = "host";
    const senderChannel = addConnectedPeer(sender, "p1");
    const senderWire = createWire(sender, smallCfg);

    // Receiver state.
    const receiver = createTransportState();
    receiver.role = "controller";
    const receiverChannel = addConnectedPeer(receiver, "host_root");
    const receiverWire = createWire(receiver, smallCfg);

    const received: { peerId: PeerId; frame: Frame }[] = [];
    receiverWire.on((peerId, frame) => received.push({ peerId, frame }));

    const frame: Frame = {
      t: "sync-snap",
      snapshot: { board: { blob: "y".repeat(3000), n: 42 } },
      sSeq: 7
    };
    senderWire.send("p1", frame);

    expect(senderChannel.sent.length).toBeGreaterThan(1);
    // Pipe each chunk into the receiver channel in order.
    for (const wireBytes of senderChannel.sent) receiverChannel.deliver(wireBytes);

    expect(received).toHaveLength(1);
    expect(received[0]?.peerId).toBe("host_root");
    expect(received[0]?.frame).toEqual(frame);
  });

  it("an un-chunked frame delivered to the receiver reaches the consumer", () => {
    const receiver = createTransportState();
    receiver.role = "controller";
    const channel = addConnectedPeer(receiver, "host_root");
    const wire = createWire(receiver, cfg);
    const seen: Frame[] = [];
    wire.on((_peerId, frame) => seen.push(frame));

    const frame: Frame = { t: "sync-delta", ops: [], sSeq: 2 };
    channel.deliver(JSON.stringify(frame));

    expect(seen).toEqual([frame]);
  });

  it("broadcast sends to every connected peer", () => {
    const state = createTransportState();
    state.role = "host";
    const c1 = addConnectedPeer(state, "p1");
    const c2 = addConnectedPeer(state, "p2");
    const wire = createWire(state, cfg);

    wire.broadcast({ t: "sync-delta", ops: [], sSeq: 1 });
    expect(c1.sent).toHaveLength(1);
    expect(c2.sent).toHaveLength(1);
  });

  it("on() returns an unsubscribe that detaches the consumer", () => {
    const state = createTransportState();
    const channel = addConnectedPeer(state, "host_root");
    const wire = createWire(state, cfg);
    const seen: Frame[] = [];
    const off = wire.on((_p, f) => seen.push(f));
    off();

    channel.deliver(JSON.stringify({ t: "sync-delta", ops: [], sSeq: 1 }));
    expect(seen).toHaveLength(0);
  });

  it("a non-object inbound message is treated as a raw frame, not a chunk envelope", () => {
    // isChunkEnvelope must return false for a primitive parse (typeof !== "object" / null), routing the
    // value straight to the consumer as a (degenerate) frame rather than the reassembly path.
    const state = createTransportState();
    state.role = "controller";
    const channel = addConnectedPeer(state, "host_root");
    const wire = createWire(state, cfg);
    const seen: unknown[] = [];
    wire.on((_p, f) => seen.push(f));

    channel.deliver(JSON.stringify(42)); // a number — not an object, not a chunk envelope
    expect(seen).toEqual([42]);
  });

  it("a null inbound message does not reach the consumer (parsed null is falsy)", () => {
    const state = createTransportState();
    state.role = "controller";
    const channel = addConnectedPeer(state, "host_root");
    const wire = createWire(state, cfg);
    const seen: unknown[] = [];
    wire.on((_p, f) => seen.push(f));

    channel.deliver(JSON.stringify(null)); // parsed null → `if (!frame) return`
    expect(seen).toHaveLength(0);
  });

  it("bindPeerChannel wires the receive pump on a freshly-connected peer", () => {
    const state = createTransportState();
    state.role = "controller";
    const channel = addConnectedPeer(state, "host_root");
    const seen: Frame[] = [];
    state.frameConsumers.add((_p, f) => seen.push(f));

    // Drive the public bindPeerChannel seam (called by handlers.ts) rather than going through Wire.
    bindPeerChannel(state, state.peers.get("host_root") as PeerConnection);

    channel.deliver(JSON.stringify({ t: "sync-delta", ops: [], sSeq: 1 }));
    expect(seen).toEqual([{ t: "sync-delta", ops: [], sSeq: 1 }]);
  });

  it("bindPeerChannel is a no-op when the peer has no channel assigned", () => {
    const state = createTransportState();
    state.role = "controller";
    addConnectedPeer(state, "host_root");
    const peer = state.peers.get("host_root") as PeerConnection;
    peer.channel = null; // attachReceive must short-circuit on `!channel`

    expect(() => bindPeerChannel(state, peer)).not.toThrow();
  });
});

describe("channel — backpressure", () => {
  it("pauses a peer when bufferedAmount exceeds the ~64 KiB threshold", () => {
    const state = createTransportState();
    state.role = "host";
    const channel = addConnectedPeer(state, "p1");
    const wire = createWire(state, cfg);

    // Saturate the buffer above the 64 KiB threshold.
    channel.bufferedAmount = 70 * 1024;
    wire.send("p1", { t: "ping", ts: 1 });

    expect(state.peers.get("p1")?.paused).toBe(true);
    // While paused, the frame is queued, not written.
    expect(channel.sent).toHaveLength(0);
  });

  it("resumes the peer and flushes the queue on bufferedamountlow", () => {
    const state = createTransportState();
    state.role = "host";
    const channel = addConnectedPeer(state, "p1");
    const wire = createWire(state, cfg);

    channel.bufferedAmount = 70 * 1024;
    wire.send("p1", { t: "ping", ts: 1 });
    expect(state.peers.get("p1")?.paused).toBe(true);

    channel.fireBufferedAmountLow();
    expect(state.peers.get("p1")?.paused).toBe(false);
    // The queued frame is flushed after drain.
    expect(channel.sent.length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(channel.sent[0] as string)).toEqual({ t: "ping", ts: 1 });
  });

  it("backpressure is per-peer — one slow controller does not stall the others", () => {
    const state = createTransportState();
    state.role = "host";
    const slow = addConnectedPeer(state, "slow");
    const fast = addConnectedPeer(state, "fast");
    const wire = createWire(state, cfg);

    slow.bufferedAmount = 70 * 1024;
    wire.broadcast({ t: "sync-delta", ops: [], sSeq: 1 });

    expect(state.peers.get("slow")?.paused).toBe(true);
    expect(slow.sent).toHaveLength(0);
    // The fast peer is unaffected.
    expect(fast.sent).toHaveLength(1);
    expect(state.peers.get("fast")?.paused).toBe(false);
  });

  it("queues a SECOND frame onto the pending buffer while the peer is already paused", () => {
    const state = createTransportState();
    state.role = "host";
    const channel = addConnectedPeer(state, "p1");
    const wire = createWire(state, cfg);

    // First send saturates the buffer → peer paused, frame #1 queued.
    channel.bufferedAmount = 70 * 1024;
    wire.send("p1", { t: "ping", ts: 1 });
    expect(state.peers.get("p1")?.paused).toBe(true);

    // Second send while still paused → appended to the pending buffer (lines 182-186), not written.
    wire.send("p1", { t: "ping", ts: 2 });
    expect(channel.sent).toHaveLength(0);

    // On drain BOTH queued frames flush in order.
    channel.fireBufferedAmountLow();
    expect(state.peers.get("p1")?.paused).toBe(false);
    const sentTs = channel.sent.map(s => JSON.parse(s).ts);
    expect(sentTs).toEqual([1, 2]);
  });

  it("queues onto an existing pending buffer even after the peer is un-paused (pending-length branch)", () => {
    // Exercises the `(pending && pending.length > 0)` half of the guard: a pending buffer that still
    // holds entries forces subsequent sends to queue regardless of the `paused` flag.
    const state = createTransportState();
    state.role = "host";
    const channel = addConnectedPeer(state, "p1");
    const wire = createWire(state, cfg);

    channel.bufferedAmount = 70 * 1024;
    wire.send("p1", { t: "ping", ts: 1 }); // pause + queue frame #1
    wire.send("p1", { t: "ping", ts: 2 }); // queue frame #2 while paused

    // Manually clear `paused` but leave the pending buffer populated — the next send must still queue.
    const peer = state.peers.get("p1") as PeerConnection;
    peer.paused = false;
    wire.send("p1", { t: "ping", ts: 3 });
    expect(channel.sent).toHaveLength(0); // still queued via the pending-length branch

    channel.fireBufferedAmountLow();
    const sentTs = channel.sent.map(s => JSON.parse(s).ts);
    expect(sentTs).toEqual([1, 2, 3]);
  });

  it("writeToPeer is a no-op when the peer has no channel assigned", () => {
    const state = createTransportState();
    state.role = "host";
    addConnectedPeer(state, "p1");
    // Null out the channel — sendFrame → writeToPeer must short-circuit on `!channel`.
    const peer = state.peers.get("p1") as PeerConnection;
    peer.channel = null;
    const wire = createWire(state, cfg);

    expect(() => wire.send("p1", { t: "ping", ts: 1 })).not.toThrow();
  });

  it("writeToPeer is a no-op when the channel is not open", () => {
    const state = createTransportState();
    state.role = "host";
    const channel = addConnectedPeer(state, "p1");
    channel.readyState = "connecting"; // not "open"
    const wire = createWire(state, cfg);

    wire.send("p1", { t: "ping", ts: 1 });
    expect(channel.sent).toHaveLength(0);
  });
});

describe("channel — heartbeat", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("broadcasts a ping to every connected peer each interval", () => {
    const state = createTransportState();
    state.role = "host";
    const channel = addConnectedPeer(state, "p1");
    startHeartbeat(state, cfg, vi.fn());

    vi.advanceTimersByTime(cfg.heartbeatIntervalMs);
    expect(channel.sent.length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(channel.sent.at(-1) as string).t).toBe("ping");
    expect(state.heartbeatTimer).not.toBeNull();
  });

  it("startHeartbeat is idempotent — a second call does not start a second interval", () => {
    const state = createTransportState();
    state.role = "host";
    addConnectedPeer(state, "p1");
    startHeartbeat(state, cfg, vi.fn());
    const firstTimer = state.heartbeatTimer;
    expect(firstTimer).not.toBeNull();

    // Second call must early-return on the `state.heartbeatTimer !== null` guard.
    startHeartbeat(state, cfg, vi.fn());
    expect(state.heartbeatTimer).toBe(firstTimer);
  });

  it("a pong updates lastPongAt and keeps the peer alive", () => {
    const state = createTransportState();
    state.role = "host";
    const channel = addConnectedPeer(state, "p1");
    const wire = createWire(state, cfg);
    wire.on(vi.fn()); // consumer attached
    const emitWarning = vi.fn();
    startHeartbeat(state, cfg, emitWarning);

    // Keep ponging within the timeout window.
    for (
      let elapsed = 0;
      elapsed < cfg.heartbeatTimeoutMs * 2;
      elapsed += cfg.heartbeatIntervalMs
    ) {
      vi.advanceTimersByTime(cfg.heartbeatIntervalMs);
      channel.deliver(JSON.stringify({ t: "pong", ts: Date.now() }));
    }

    expect(emitWarning).not.toHaveBeenCalled();
    expect(state.peers.has("p1")).toBe(true);
  });

  it("declares a peer dead after heartbeatTimeoutMs with no pong and removes it", () => {
    const state = createTransportState();
    state.role = "host";
    addConnectedPeer(state, "p1");
    const emitWarning = vi.fn();
    startHeartbeat(state, cfg, emitWarning);

    vi.advanceTimersByTime(cfg.heartbeatTimeoutMs + cfg.heartbeatIntervalMs);

    expect(emitWarning).toHaveBeenCalledWith("channel-closed");
    expect(state.peers.has("p1")).toBe(false);
  });

  it("de-dups the channel-closed warning per peer-epoch", () => {
    const state = createTransportState();
    state.role = "host";
    addConnectedPeer(state, "p1");
    addConnectedPeer(state, "p2");
    const emitWarning = vi.fn();
    startHeartbeat(state, cfg, emitWarning);

    // Run well past the timeout multiple ticks — each dead peer warns exactly once.
    vi.advanceTimersByTime(cfg.heartbeatTimeoutMs + cfg.heartbeatIntervalMs * 3);

    expect(emitWarning).toHaveBeenCalledTimes(2);
    expect(emitWarning).toHaveBeenCalledWith("channel-closed");
  });

  it("handles ping/pong internally — they never reach the frame consumer", () => {
    const state = createTransportState();
    state.role = "controller";
    const channel = addConnectedPeer(state, "host_root");
    const wire = createWire(state, cfg);
    const seen: Frame[] = [];
    wire.on((_p, f) => seen.push(f));

    channel.deliver(JSON.stringify({ t: "ping", ts: 1 }));
    channel.deliver(JSON.stringify({ t: "pong", ts: 1 }));

    expect(seen).toHaveLength(0);
    // A controller auto-replies to a ping with a pong.
    const replies = channel.sent.map(s => JSON.parse(s).t);
    expect(replies).toContain("pong");
  });

  it("stops the heartbeat interval on tearDownState", async () => {
    const state = createTransportState();
    state.role = "host";
    const channel = addConnectedPeer(state, "p1");
    startHeartbeat(state, cfg, vi.fn());
    expect(state.heartbeatTimer).not.toBeNull();

    await tearDownState(state);
    expect(state.heartbeatTimer).toBeNull();

    const before = channel.sent.length;
    vi.advanceTimersByTime(cfg.heartbeatIntervalMs * 3);
    expect(channel.sent.length).toBe(before);
  });

  it("fires peerLostCb with the peer id once when the heartbeat declares a peer dead (D18)", () => {
    const state = createTransportState();
    state.role = "host";
    addConnectedPeer(state, "p_dead");
    const peerLostCb = vi.fn();
    state.peerLostCb = peerLostCb;
    startHeartbeat(state, cfg, vi.fn());

    vi.advanceTimersByTime(cfg.heartbeatTimeoutMs + cfg.heartbeatIntervalMs);

    expect(peerLostCb).toHaveBeenCalledTimes(1);
    expect(peerLostCb).toHaveBeenCalledWith("p_dead");
  });

  it("does not fire peerLostCb a second time for the same dead peer on subsequent ticks (D18)", () => {
    const state = createTransportState();
    state.role = "host";
    addConnectedPeer(state, "p_dead");
    const peerLostCb = vi.fn();
    state.peerLostCb = peerLostCb;
    startHeartbeat(state, cfg, vi.fn());

    vi.advanceTimersByTime(cfg.heartbeatTimeoutMs + cfg.heartbeatIntervalMs * 4);

    // The peer is gone after the first death — cb fires exactly once.
    expect(peerLostCb).toHaveBeenCalledTimes(1);
  });
});

describe("channel — teardown", () => {
  it("disconnectPeer closes channel + pc, clears timers, removes from the map", () => {
    const state = createTransportState();
    const channel = addConnectedPeer(state, "p1");
    const peer = state.peers.get("p1") as PeerConnection;
    peer.openTimer = setTimeout(() => {}, 10_000);
    const pcClosed = (peer.pc as unknown as FakePeerConnection).closed;

    disconnectPeer(state, "p1");

    expect(channel.closed).toHaveBeenCalled();
    expect(pcClosed).toHaveBeenCalled();
    expect(state.peers.has("p1")).toBe(false);
  });

  it("disconnectPeer clears the per-peer warn keys so a same-id reconnect can warn again", () => {
    const state = createTransportState();
    addConnectedPeer(state, "p1");
    state.warned.add("channel-closed:p1");
    state.warned.add("ice-failed:p1");
    // A different peer's keys must survive (clear is per-peer, not global).
    state.warned.add("channel-closed:p2");

    disconnectPeer(state, "p1");

    expect(state.warned.has("channel-closed:p1")).toBe(false);
    expect(state.warned.has("ice-failed:p1")).toBe(false);
    expect(state.warned.has("channel-closed:p2")).toBe(true);
  });

  it("disconnectPeer is idempotent for an unknown peer", () => {
    const state = createTransportState();
    expect(() => disconnectPeer(state, "ghost")).not.toThrow();
  });

  it("tearDownState closes every peer and leaves the session", async () => {
    const state = createTransportState();
    state.role = "host";
    const c1 = addConnectedPeer(state, "p1");
    const c2 = addConnectedPeer(state, "p2");
    const leave = vi.fn().mockResolvedValue(undefined);
    state.session = {
      onPeer: vi.fn(),
      onPeerLeave: vi.fn(),
      onSignal: vi.fn(),
      send: vi.fn(),
      leave
    };

    await tearDownState(state);

    expect(c1.closed).toHaveBeenCalled();
    expect(c2.closed).toHaveBeenCalled();
    expect(state.peers.size).toBe(0);
    expect(leave).toHaveBeenCalledTimes(1);
    expect(state.session).toBeNull();
  });

  it("tearDownState is a safe no-op when already torn down", async () => {
    const state = createTransportState();
    await expect(tearDownState(state)).resolves.toBeUndefined();
  });

  it("tearDownState nulls peerConnectedCb and peerLostCb (D18 clean reset)", async () => {
    const state = createTransportState();
    state.peerConnectedCb = vi.fn();
    state.peerLostCb = vi.fn();

    await tearDownState(state);

    expect(state.peerConnectedCb).toBeNull();
    expect(state.peerLostCb).toBeNull();
  });

  it("tearDownState does NOT fire peerLostCb for any connected peers during teardown (D18)", async () => {
    const state = createTransportState();
    state.role = "host";
    addConnectedPeer(state, "p1");
    addConnectedPeer(state, "p2");
    const peerLostCb = vi.fn();
    state.peerLostCb = peerLostCb;

    await tearDownState(state);

    // Teardown must not invoke peerLostCb — it is heartbeat-death only.
    expect(peerLostCb).not.toHaveBeenCalled();
  });
});
