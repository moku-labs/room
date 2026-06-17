/**
 * @file Unit tests for the signaling-glue handlers.
 * @see ../../handlers.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IceCandidateInit, RoomEvents, SignalMsg } from "../../../../contracts";
import { handlePeerArrival, handlePeerLeave, handleSignal } from "../../handlers";
import { createTransportState } from "../../state";
import type { PeerConnection, TransportConfig, TransportState } from "../../types";

/** A typed `emitWarning` spy matching the narrowed `room:network-warning` reason closure. */
function emitWarningSpy(): (reason: RoomEvents["room:network-warning"]["reason"]) => void {
  return vi.fn();
}

/** A no-op `emitWarning` for tests that do not assert on warnings. */
const noopWarn: (reason: RoomEvents["room:network-warning"]["reason"]) => void = () => {};

// ─────────────────────────────────────────────────────────────────────────────
// A minimal RTCPeerConnection stand-in. Tracks remote/local descriptions and
// candidates, and lets a test drive iceConnectionState + the SDP callbacks.
// ─────────────────────────────────────────────────────────────────────────────

class FakePeerConnection {
  iceConnectionState: RTCIceConnectionState = "new";
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  readonly addedCandidates: (IceCandidateInit | undefined)[] = [];
  readonly createdChannels: string[] = [];
  onicecandidate: ((event: { candidate: RTCIceCandidate | null }) => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  ondatachannel: ((event: { channel: RTCDataChannel }) => void) | null = null;
  readonly closed = vi.fn();

  createDataChannel(label: string): RTCDataChannel {
    this.createdChannels.push(label);
    return { addEventListener: vi.fn(), close: vi.fn() } as unknown as RTCDataChannel;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: "offer", sdp: "v=0...offer" };
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: "answer", sdp: "v=0...answer" };
  }

  async setLocalDescription(desc?: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = desc ?? { type: "offer", sdp: "v=0...local" };
  }

  async setRemoteDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = desc;
  }

  async addIceCandidate(candidate?: IceCandidateInit): Promise<void> {
    this.addedCandidates.push(candidate);
  }

  readonly restartIce = vi.fn();

  close(): void {
    this.closed();
  }

  /** Drive ICE to connected and fire the state-change handler. */
  goConnected(): void {
    this.iceConnectionState = "connected";
    this.oniceconnectionstatechange?.();
  }

  /** Drive ICE to a transient `disconnected` and fire the state-change handler. */
  goDisconnected(): void {
    this.iceConnectionState = "disconnected";
    this.oniceconnectionstatechange?.();
  }
}

const cfg: TransportConfig = {
  signaling: { join: vi.fn() },
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  heartbeatIntervalMs: 2000,
  heartbeatTimeoutMs: 6000,
  openTimeoutMs: 3000,
  maxMessageBytes: 14_336
};

/** A session double whose handshake methods are spies (inferred so `.mock` stays accessible). */
function fakeSession() {
  return {
    onPeer: vi.fn(),
    onPeerLeave: vi.fn(),
    onSignal: vi.fn(),
    send: vi.fn(),
    leave: vi.fn().mockResolvedValue(undefined)
  };
}

/** Seed a controller-side peer record holding a fake pc (passive answerer). */
function seedPeer(state: TransportState, peerId: string): FakePeerConnection {
  const pc = new FakePeerConnection();
  const peer: PeerConnection = {
    peerId,
    pc: pc as unknown as RTCPeerConnection,
    channel: null,
    state: "connecting",
    lastPongAt: Date.now(),
    paused: false,
    reassembly: new Map(),
    openTimer: null,
    retries: 0
  };
  state.peers.set(peerId, peer);
  return pc;
}

// Patch the global RTCPeerConnection constructor for host-side handlePeerArrival.
let originalRtc: typeof RTCPeerConnection | undefined;
beforeEach(() => {
  originalRtc = globalThis.RTCPeerConnection;
  globalThis.RTCPeerConnection = FakePeerConnection as unknown as typeof RTCPeerConnection;
});
afterEach(() => {
  if (originalRtc) globalThis.RTCPeerConnection = originalRtc;
  vi.restoreAllMocks();
});

describe("handlePeerArrival", () => {
  it("host (active) creates a pc + data channel and sends an offer", async () => {
    const state = createTransportState();
    state.role = "host";
    state.selfId = "host_root";
    const session = fakeSession();
    state.session = session;

    handlePeerArrival(state, cfg, "p_ab12", noopWarn);
    await vi.waitFor(() => expect(session.send).toHaveBeenCalled());

    expect(state.peers.has("p_ab12")).toBe(true);
    const peer = state.peers.get("p_ab12") as PeerConnection;
    expect((peer.pc as unknown as FakePeerConnection).createdChannels.length).toBeGreaterThan(0);
    const [, msg] = session.send.mock.calls[0] as [string, SignalMsg];
    expect(msg.kind).toBe("offer");
  });

  it("controller (passive) does not create an offer on peer arrival", () => {
    const state = createTransportState();
    state.role = "controller";
    state.selfId = "p_ab12";
    const session = fakeSession();
    state.session = session;

    handlePeerArrival(state, cfg, "host_root", noopWarn);
    expect(session.send).not.toHaveBeenCalled();
  });

  it("arms an open-timeout timer on the new host-side channel", () => {
    const state = createTransportState();
    state.role = "host";
    state.session = fakeSession();
    handlePeerArrival(state, cfg, "p_ab12", noopWarn);
    expect(state.peers.get("p_ab12")?.openTimer).not.toBeNull();
  });

  it("recovers a transient ICE blip by calling restartIce() on the disconnected transition", async () => {
    const state = createTransportState();
    state.role = "host";
    state.session = fakeSession();

    handlePeerArrival(state, cfg, "p_ab12", noopWarn);
    await vi.waitFor(() => expect(state.peers.has("p_ab12")).toBe(true));
    const pc = state.peers.get("p_ab12")?.pc as unknown as FakePeerConnection;

    pc.goDisconnected();
    expect(pc.restartIce).toHaveBeenCalledTimes(1);
    // A transient blip does NOT remove the peer — restartIce drives recovery.
    expect(state.peers.has("p_ab12")).toBe(true);
  });
});

describe("open-timeout retry (capped) — ice-failed on exhaustion", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries the handshake a bounded number of times, then emits ice-failed once and drops the peer", async () => {
    const state = createTransportState();
    state.role = "host";
    state.session = fakeSession();
    const warn = emitWarningSpy();

    // The host offerer whose channel never opens — createDataChannel returns a stub whose
    // "open" listener is never invoked, so every openTimer fires retryHandshake.
    handlePeerArrival(state, cfg, "p_ab12", warn);
    await vi.waitFor(() => expect(state.peers.has("p_ab12")).toBe(true));

    // Count distinct pc instances minted across the retry cycles. Each retry deletes + recreates.
    const seenPcs = new Set<FakePeerConnection>();
    const recordPc = (): void => {
      const peer = state.peers.get("p_ab12");
      if (peer) seenPcs.add(peer.pc as unknown as FakePeerConnection);
    };
    recordPc();

    // Advance past the open timeout enough cycles to exceed the cap. Flush microtasks between
    // each tick so the async offer IIFE settles before the next timer fires.
    const cycles = 6; // > MAX_OPEN_RETRIES (3) + 1
    for (let cycle = 0; cycle < cycles; cycle += 1) {
      await vi.advanceTimersByTimeAsync(cfg.openTimeoutMs);
      recordPc();
    }

    // Exactly MAX_OPEN_RETRIES (3) re-handshakes happened → 1 initial pc + 3 retry pcs = 4 distinct.
    expect(seenPcs.size).toBe(4);
    // ice-failed emitted exactly once on exhaustion.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("ice-failed");
    // After exhaustion the peer is gone and no further retries occur.
    expect(state.peers.has("p_ab12")).toBe(false);

    // Advancing further must NOT re-arm or re-emit (the loop has truly stopped).
    await vi.advanceTimersByTimeAsync(cfg.openTimeoutMs * 3);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(state.peers.has("p_ab12")).toBe(false);
  });

  it("does not retry or warn when the channel opens within the timeout", async () => {
    const state = createTransportState();
    state.role = "host";
    state.session = fakeSession();
    const warn = emitWarningSpy();

    handlePeerArrival(state, cfg, "p_ab12", warn);
    await vi.advanceTimersByTimeAsync(0);
    const peer = state.peers.get("p_ab12") as PeerConnection;
    const firstPc = peer.pc as unknown as FakePeerConnection;

    // ICE reaches connected before the open timer fires → timer cleared, no retry.
    firstPc.goConnected();
    await vi.advanceTimersByTimeAsync(cfg.openTimeoutMs * 5);

    expect(warn).not.toHaveBeenCalled();
    // Same pc instance — never torn down and recreated.
    expect(state.peers.get("p_ab12")?.pc).toBe(firstPc as unknown as RTCPeerConnection);
  });
});

describe("handleSignal", () => {
  it("applying an inbound offer SignalMsg triggers an answer send", async () => {
    const state = createTransportState();
    state.role = "controller";
    state.selfId = "p_ab12";
    const session = fakeSession();
    state.session = session;

    handleSignal(state, cfg, "host_root", { kind: "offer", sdp: "v=0...offer" });
    await vi.waitFor(() => expect(session.send).toHaveBeenCalled());

    const [target, msg] = session.send.mock.calls[0] as [string, SignalMsg];
    expect(target).toBe("host_root");
    expect(msg.kind).toBe("answer");
    // The remote offer was applied.
    const peer = state.peers.get("host_root") as PeerConnection;
    expect((peer.pc as unknown as FakePeerConnection).remoteDescription?.type).toBe("offer");
  });

  it("an inbound answer is set as the remote description (no answer back)", async () => {
    const state = createTransportState();
    state.role = "host";
    const session = fakeSession();
    state.session = session;
    const pc = seedPeer(state, "p_ab12");

    handleSignal(state, cfg, "p_ab12", { kind: "answer", sdp: "v=0...answer" });
    await vi.waitFor(() => expect(pc.remoteDescription?.type).toBe("answer"));
    expect(session.send).not.toHaveBeenCalled();
  });

  it("an inbound candidate SignalMsg is added via addIceCandidate", async () => {
    const state = createTransportState();
    state.role = "host";
    state.session = fakeSession();
    const pc = seedPeer(state, "p_ab12");

    const candidate: IceCandidateInit = {
      candidate: "candidate:1 1 udp",
      sdpMid: "0",
      sdpMLineIndex: 0
    };
    handleSignal(state, cfg, "p_ab12", { kind: "candidate", candidate });

    await vi.waitFor(() => expect(pc.addedCandidates.length).toBe(1));
    expect(pc.addedCandidates[0]).toEqual(candidate);
  });

  it("stays joined until iceConnectionState is connected, then leaves (trickle ICE)", async () => {
    const state = createTransportState();
    state.role = "controller";
    state.selfId = "p_ab12";
    const session = fakeSession();
    state.session = session;

    handleSignal(state, cfg, "host_root", { kind: "offer", sdp: "v=0...offer" });
    await vi.waitFor(() => expect(state.peers.has("host_root")).toBe(true));

    // Not connected yet → still joined.
    expect(session.leave).not.toHaveBeenCalled();

    const peer = state.peers.get("host_root") as PeerConnection;
    (peer.pc as unknown as FakePeerConnection).goConnected();
    await vi.waitFor(() => expect(session.leave).toHaveBeenCalledTimes(1));
  });
});

describe("handlePeerLeave", () => {
  it("is bookkeeping-only during a handshake: removes a not-yet-connected peer, emits no Moku event", () => {
    const state = createTransportState();
    state.role = "host";
    const pc = seedPeer(state, "p_ab12");

    handlePeerLeave(state, "p_ab12");
    expect(state.peers.has("p_ab12")).toBe(false);
    expect(pc.closed).toHaveBeenCalled();
  });

  it("leaves an already-connected peer in place (heartbeat owns established dead-detection)", () => {
    const state = createTransportState();
    const pc = seedPeer(state, "p_ab12");
    (state.peers.get("p_ab12") as PeerConnection).state = "connected";

    handlePeerLeave(state, "p_ab12");
    expect(state.peers.has("p_ab12")).toBe(true);
    expect(pc.closed).not.toHaveBeenCalled();
  });

  it("is a no-op for an unknown peer", () => {
    const state = createTransportState();
    expect(() => handlePeerLeave(state, "ghost")).not.toThrow();
  });
});

describe("handlePeerArrival — peerConnectedCb (D18 loopback path)", () => {
  it("fires peerConnectedCb immediately after binding the loopback channel", () => {
    const state = createTransportState();
    const peerConnectedCb = vi.fn();
    state.peerConnectedCb = peerConnectedCb;

    // Build a loopback session double that exposes openWireChannel.
    const loopbackChannel = {
      readyState: "open" as const,
      bufferedAmount: 0,
      bufferedAmountLowThreshold: 0,
      onmessage: null as ((event: { data: string }) => void) | null,
      send: vi.fn(),
      close: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    };
    state.session = {
      onPeer: vi.fn(),
      onPeerLeave: vi.fn(),
      onSignal: vi.fn(),
      send: vi.fn(),
      leave: vi.fn().mockResolvedValue(undefined),
      openWireChannel: (peerId: string) => (peerId === "p_ab12" ? loopbackChannel : null)
    } as unknown as (typeof state)["session"];

    handlePeerArrival(state, cfg, "p_ab12", noopWarn);

    expect(peerConnectedCb).toHaveBeenCalledTimes(1);
    expect(peerConnectedCb).toHaveBeenCalledWith("p_ab12");
  });

  it("does not fire peerConnectedCb when the loopback channel is null for the peer", () => {
    const state = createTransportState();
    const peerConnectedCb = vi.fn();
    state.peerConnectedCb = peerConnectedCb;

    state.session = {
      onPeer: vi.fn(),
      onPeerLeave: vi.fn(),
      onSignal: vi.fn(),
      send: vi.fn(),
      leave: vi.fn().mockResolvedValue(undefined),
      openWireChannel: (_peerId: string) => null
    } as unknown as (typeof state)["session"];

    handlePeerArrival(state, cfg, "p_ab12", noopWarn);

    expect(peerConnectedCb).not.toHaveBeenCalled();
  });

  it("does not fire peerConnectedCb when peerConnectedCb is null", () => {
    const state = createTransportState();
    // peerConnectedCb stays null — just verify no crash and no cb call.
    const loopbackChannel = {
      readyState: "open" as const,
      bufferedAmount: 0,
      bufferedAmountLowThreshold: 0,
      onmessage: null as ((event: { data: string }) => void) | null,
      send: vi.fn(),
      close: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    };
    state.session = {
      onPeer: vi.fn(),
      onPeerLeave: vi.fn(),
      onSignal: vi.fn(),
      send: vi.fn(),
      leave: vi.fn().mockResolvedValue(undefined),
      openWireChannel: (peerId: string) => (peerId === "p_ab12" ? loopbackChannel : null)
    } as unknown as (typeof state)["session"];

    expect(() => handlePeerArrival(state, cfg, "p_ab12", noopWarn)).not.toThrow();
    expect(state.peers.has("p_ab12")).toBe(true);
  });
});
