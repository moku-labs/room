/**
 * @file Unit tests for the signaling-glue handlers.
 * @see ../../handlers.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IceCandidateInit, RoomEvents, SignalMsg } from "../../../../contracts";
import { inMemory } from "../../adapters/in-memory";
import type { WireChannel } from "../../channel";
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

// ─────────────────────────────────────────────────────────────────────────────
// A WireChannel stand-in whose "open" listener is captured so a test can fire it
// (the default FakePeerConnection.createDataChannel returns a no-op stub). Drives
// the host-side and answerer-side "open" → peerConnectedCb paths.
// ─────────────────────────────────────────────────────────────────────────────

/** An open `WireChannel` double that remembers its registered `"open"` listener. */
function openableChannel(): WireChannel & { fireOpen(): void } {
  let openCb: (() => void) | null = null;
  return {
    readyState: "open",
    bufferedAmount: 0,
    bufferedAmountLowThreshold: 0,
    onmessage: null,
    send: vi.fn(),
    close: vi.fn(),
    addEventListener(type: string, cb: () => void): void {
      if (type === "open") openCb = cb;
    },
    removeEventListener: vi.fn(),
    fireOpen(): void {
      openCb?.();
    }
  };
}

describe("handlePeerArrival — loopback duplicate + null-channel guards", () => {
  it("returns early on a duplicate loopback arrival (no second peer record, no extra cb)", () => {
    const state = createTransportState();
    const peerConnectedCb = vi.fn();
    state.peerConnectedCb = peerConnectedCb;
    const openWireChannel = vi.fn((peerId: string) =>
      peerId === "p_ab12" ? (openableChannel() as unknown as WireChannel) : null
    );
    state.session = {
      onPeer: vi.fn(),
      onPeerLeave: vi.fn(),
      onSignal: vi.fn(),
      send: vi.fn(),
      leave: vi.fn().mockResolvedValue(undefined),
      openWireChannel
    } as unknown as (typeof state)["session"];

    handlePeerArrival(state, cfg, "p_ab12", noopWarn);
    const firstPeer = state.peers.get("p_ab12") as PeerConnection;

    // Second arrival for the same peer short-circuits before opening another channel.
    handlePeerArrival(state, cfg, "p_ab12", noopWarn);

    expect(state.peers.get("p_ab12")).toBe(firstPeer);
    expect(peerConnectedCb).toHaveBeenCalledTimes(1);
    expect(openWireChannel).toHaveBeenCalledTimes(1);
  });

  it("drives the loopback branch end-to-end via the inMemory adapter", async () => {
    const sig = inMemory();
    await sig.join("K7M2QX", { selfId: "p_ab12", passive: true });
    const hostSession = await sig.join("K7M2QX", { selfId: "host_root" });

    const state = createTransportState();
    state.role = "host";
    state.selfId = "host_root";
    state.session = hostSession;
    const peerConnectedCb = vi.fn();
    state.peerConnectedCb = peerConnectedCb;

    handlePeerArrival(state, cfg, "p_ab12", noopWarn);

    const peer = state.peers.get("p_ab12") as PeerConnection;
    expect(peer).toBeDefined();
    // Loopback peers are marked connected immediately with no RTCPeerConnection handshake.
    expect(peer.state).toBe("connected");
    expect(peer.channel).not.toBeNull();
    expect(peerConnectedCb).toHaveBeenCalledWith("p_ab12");
  });
});

describe("handlePeerArrival — host channel open + ICE callbacks (real path)", () => {
  it("fires peerConnectedCb and clears the open timer when the host data channel opens", () => {
    const channel = openableChannel();
    class OpenableHostPc extends FakePeerConnection {
      override createDataChannel(): RTCDataChannel {
        return channel as unknown as RTCDataChannel;
      }
    }
    globalThis.RTCPeerConnection = OpenableHostPc as unknown as typeof RTCPeerConnection;

    const state = createTransportState();
    state.role = "host";
    state.session = fakeSession();
    const peerConnectedCb = vi.fn();
    state.peerConnectedCb = peerConnectedCb;

    handlePeerArrival(state, cfg, "p_ab12", noopWarn);
    const peer = state.peers.get("p_ab12") as PeerConnection;
    expect(peer.openTimer).not.toBeNull();

    channel.fireOpen();

    expect(peerConnectedCb).toHaveBeenCalledTimes(1);
    expect(peerConnectedCb).toHaveBeenCalledWith("p_ab12");
    // The "open" listener clears the armed open-timeout timer.
    expect(peer.openTimer).toBeNull();
  });

  it("trickles each local ICE candidate to the peer over the signaling plane", async () => {
    const state = createTransportState();
    state.role = "host";
    const session = fakeSession();
    state.session = session;

    handlePeerArrival(state, cfg, "p_ab12", noopWarn);
    await vi.waitFor(() => expect(state.peers.has("p_ab12")).toBe(true));
    const pc = state.peers.get("p_ab12")?.pc as unknown as FakePeerConnection;

    // Reset to drop the offer send recorded by handlePeerArrival's IIFE.
    session.send.mockClear();
    pc.onicecandidate?.({
      candidate: {
        candidate: "candidate:1 1 udp 2122 192.168.0.2 5000 typ host",
        sdpMid: "0",
        sdpMLineIndex: 0,
        usernameFragment: "ufrag"
      } as unknown as RTCIceCandidate
    });

    const [target, msg] = session.send.mock.calls[0] as [string, SignalMsg];
    expect(target).toBe("p_ab12");
    expect(msg.kind).toBe("candidate");
  });

  it("does not send when an end-of-candidates (null) ICE event fires", async () => {
    const state = createTransportState();
    state.role = "host";
    const session = fakeSession();
    state.session = session;

    handlePeerArrival(state, cfg, "p_ab12", noopWarn);
    await vi.waitFor(() => expect(state.peers.has("p_ab12")).toBe(true));
    const pc = state.peers.get("p_ab12")?.pc as unknown as FakePeerConnection;

    session.send.mockClear();
    pc.onicecandidate?.({ candidate: null });
    expect(session.send).not.toHaveBeenCalled();
  });

  it("clears the open timer and leaves the session once ICE reaches connected", async () => {
    const state = createTransportState();
    state.role = "host";
    const session = fakeSession();
    state.session = session;

    handlePeerArrival(state, cfg, "p_ab12", noopWarn);
    await vi.waitFor(() => expect(state.peers.has("p_ab12")).toBe(true));
    const peer = state.peers.get("p_ab12") as PeerConnection;
    expect(peer.openTimer).not.toBeNull();

    (peer.pc as unknown as FakePeerConnection).goConnected();

    expect(peer.state).toBe("connected");
    expect(peer.openTimer).toBeNull();
    await vi.waitFor(() => expect(session.leave).toHaveBeenCalledTimes(1));
    // leave() resolving nulls the live session (contracts §1.2).
    await vi.waitFor(() => expect(state.session).toBeNull());
  });

  it("ignores a non-terminal ICE transition (checking) without restartIce or teardown", async () => {
    const state = createTransportState();
    state.role = "host";
    state.session = fakeSession();

    handlePeerArrival(state, cfg, "p_ab12", noopWarn);
    await vi.waitFor(() => expect(state.peers.has("p_ab12")).toBe(true));
    const pc = state.peers.get("p_ab12")?.pc as unknown as FakePeerConnection;

    pc.iceConnectionState = "checking";
    pc.oniceconnectionstatechange?.();

    expect(pc.restartIce).not.toHaveBeenCalled();
    expect(state.peers.get("p_ab12")?.state).toBe("connecting");
  });
});

describe("retryHandshake — early return + warn de-dup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not retry or warn when the peer reaches connected before the open timer fires", async () => {
    const state = createTransportState();
    state.role = "host";
    state.session = fakeSession();
    const warn = emitWarningSpy();

    handlePeerArrival(state, cfg, "p_ab12", warn);
    await vi.advanceTimersByTimeAsync(0);
    const peer = state.peers.get("p_ab12") as PeerConnection;

    // Mark connected (but leave the openTimer armed) so the timer's retryHandshake sees
    // peer.state === "connected" and returns early without tearing the peer down.
    peer.state = "connected";
    await vi.advanceTimersByTimeAsync(cfg.openTimeoutMs);

    expect(warn).not.toHaveBeenCalled();
    expect(state.peers.has("p_ab12")).toBe(true);
    expect((peer.pc as unknown as FakePeerConnection).closed).not.toHaveBeenCalled();
  });

  it("emits ice-failed only once even when a stale ice-failed key is already present", async () => {
    const state = createTransportState();
    state.role = "host";
    state.session = fakeSession();
    const warn = emitWarningSpy();
    // Pre-seed the de-dup guard: a prior epoch already warned for this peer.
    state.warned.add("ice-failed:p_ab12");

    handlePeerArrival(state, cfg, "p_ab12", warn);
    await vi.waitFor(() => expect(state.peers.has("p_ab12")).toBe(true));

    // Exhaust the retry budget; the de-dup guard suppresses a second emit.
    for (let cycle = 0; cycle < 6; cycle += 1) {
      await vi.advanceTimersByTimeAsync(cfg.openTimeoutMs);
    }

    expect(warn).not.toHaveBeenCalled();
    expect(state.peers.has("p_ab12")).toBe(false);
  });
});

describe("handleSignal — loopback no-op + answerer datachannel path", () => {
  it("is a no-op over a loopback session (no SDP applied, nothing sent)", () => {
    const state = createTransportState();
    state.role = "controller";
    const send = vi.fn();
    state.session = {
      onPeer: vi.fn(),
      onPeerLeave: vi.fn(),
      onSignal: vi.fn(),
      send,
      leave: vi.fn().mockResolvedValue(undefined),
      openWireChannel: vi.fn(() => null)
    } as unknown as (typeof state)["session"];

    handleSignal(state, cfg, "host_root", { kind: "offer", sdp: "v=0...offer" });
    handleSignal(state, cfg, "host_root", { kind: "answer", sdp: "v=0...answer" });

    expect(send).not.toHaveBeenCalled();
    expect(state.peers.has("host_root")).toBe(false);
  });

  it("binds the host-offered data channel and fires peerConnectedCb on open (answerer)", async () => {
    const state = createTransportState();
    state.role = "controller";
    state.selfId = "p_ab12";
    state.session = fakeSession();
    const peerConnectedCb = vi.fn();
    state.peerConnectedCb = peerConnectedCb;

    handleSignal(state, cfg, "host_root", { kind: "offer", sdp: "v=0...offer" });
    await vi.waitFor(() => expect(state.peers.has("host_root")).toBe(true));
    const peer = state.peers.get("host_root") as PeerConnection;
    const pc = peer.pc as unknown as FakePeerConnection;
    expect(peer.openTimer).not.toBeNull();

    // The host's negotiated DataChannel arrives, then opens.
    const channel = openableChannel();
    pc.ondatachannel?.({ channel: channel as unknown as RTCDataChannel });
    expect(peer.channel).not.toBeNull();

    channel.fireOpen();

    expect(peerConnectedCb).toHaveBeenCalledTimes(1);
    expect(peerConnectedCb).toHaveBeenCalledWith("host_root");
    // The "open" listener clears the answerer's armed open-timeout timer.
    expect(peer.openTimer).toBeNull();
  });

  it("nulls the answerer open timer when it elapses before the channel opens", async () => {
    vi.useFakeTimers();
    try {
      const state = createTransportState();
      state.role = "controller";
      state.selfId = "p_ab12";
      state.session = fakeSession();

      handleSignal(state, cfg, "host_root", { kind: "offer", sdp: "v=0...offer" });
      await vi.advanceTimersByTimeAsync(0);
      const peer = state.peers.get("host_root") as PeerConnection;
      expect(peer.openTimer).not.toBeNull();

      // The answerer's open-timeout guard fires: it only nulls its own handle (no retry).
      await vi.advanceTimersByTimeAsync(cfg.openTimeoutMs);
      expect(peer.openTimer).toBeNull();
      expect(state.peers.has("host_root")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("handlePeerLeave — clears the open timer of a half-open peer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("clears a not-yet-connected peer's armed open timer before removing it", () => {
    const state = createTransportState();
    const pc = seedPeer(state, "p_ab12");
    const peer = state.peers.get("p_ab12") as PeerConnection;
    const cleared = vi.fn();
    peer.openTimer = setTimeout(cleared, 10_000) as unknown as PeerConnection["openTimer"];

    handlePeerLeave(state, "p_ab12");

    expect(state.peers.has("p_ab12")).toBe(false);
    expect(pc.closed).toHaveBeenCalled();
    // The timer was cleared by handlePeerLeave, so advancing past it never runs the callback.
    vi.advanceTimersByTime(20_000);
    expect(cleared).not.toHaveBeenCalled();
  });
});

describe("handlers — non-fatal failure paths (best-effort signaling)", () => {
  it("swallows a leave() rejection after ICE connects (signaling is best-effort post-ICE)", async () => {
    const state = createTransportState();
    state.role = "host";
    const session = fakeSession();
    session.leave.mockRejectedValue(new Error("relay gone"));
    state.session = session;

    handlePeerArrival(state, cfg, "p_ab12", noopWarn);
    await vi.waitFor(() => expect(state.peers.has("p_ab12")).toBe(true));
    const peer = state.peers.get("p_ab12") as PeerConnection;

    // ICE connects → leave() runs and rejects; the .catch keeps it non-fatal.
    expect(() => (peer.pc as unknown as FakePeerConnection).goConnected()).not.toThrow();
    await vi.waitFor(() => expect(session.leave).toHaveBeenCalledTimes(1));
    // leave() rejected, so the session is NOT nulled (the success-only branch never ran).
    expect(state.session).toBe(session);
  });

  it("swallows a createOffer rejection on the host arrival path (open-timeout retry recovers)", async () => {
    class RejectingOfferPc extends FakePeerConnection {
      override async createOffer(): Promise<RTCSessionDescriptionInit> {
        throw new Error("createOffer failed");
      }
    }
    globalThis.RTCPeerConnection = RejectingOfferPc as unknown as typeof RTCPeerConnection;

    const state = createTransportState();
    state.role = "host";
    const session = fakeSession();
    state.session = session;

    expect(() => handlePeerArrival(state, cfg, "p_ab12", noopWarn)).not.toThrow();
    await vi.waitFor(() => expect(state.peers.has("p_ab12")).toBe(true));
    // The peer is still registered; no offer was sent because createOffer rejected.
    expect(session.send).not.toHaveBeenCalled();
  });

  it("sends an offer with an empty sdp when createOffer yields no sdp", async () => {
    class NoSdpOfferPc extends FakePeerConnection {
      override async createOffer(): Promise<RTCSessionDescriptionInit> {
        return { type: "offer" };
      }
    }
    globalThis.RTCPeerConnection = NoSdpOfferPc as unknown as typeof RTCPeerConnection;

    const state = createTransportState();
    state.role = "host";
    const session = fakeSession();
    state.session = session;

    handlePeerArrival(state, cfg, "p_ab12", noopWarn);
    await vi.waitFor(() => expect(session.send).toHaveBeenCalled());

    const [, msg] = session.send.mock.calls[0] as [string, SignalMsg];
    expect(msg.kind).toBe("offer");
    expect(msg).toEqual({ kind: "offer", sdp: "" });
  });

  it("swallows an addIceCandidate rejection (trickle-ICE may deliver out of order)", async () => {
    const state = createTransportState();
    state.role = "host";
    state.session = fakeSession();
    const pc = seedPeer(state, "p_ab12");
    const rejection = vi.fn().mockRejectedValue(new Error("bad candidate"));
    (pc as unknown as { addIceCandidate: () => Promise<void> }).addIceCandidate = rejection;

    const candidate: IceCandidateInit = {
      candidate: "candidate:bad",
      sdpMid: "0",
      sdpMLineIndex: 0
    };
    expect(() =>
      handleSignal(state, cfg, "p_ab12", { kind: "candidate", candidate })
    ).not.toThrow();
    await vi.waitFor(() => expect(rejection).toHaveBeenCalledTimes(1));
  });

  it("swallows a setRemoteDescription rejection on an inbound answer", async () => {
    const state = createTransportState();
    state.role = "host";
    state.session = fakeSession();
    const pc = seedPeer(state, "p_ab12");
    const rejection = vi.fn().mockRejectedValue(new Error("bad answer"));
    (pc as unknown as { setRemoteDescription: () => Promise<void> }).setRemoteDescription =
      rejection;

    expect(() =>
      handleSignal(state, cfg, "p_ab12", { kind: "answer", sdp: "v=0...answer" })
    ).not.toThrow();
    await vi.waitFor(() => expect(rejection).toHaveBeenCalledTimes(1));
  });

  it("swallows an answer-creation rejection on an inbound offer", async () => {
    class RejectingAnswerPc extends FakePeerConnection {
      override async createAnswer(): Promise<RTCSessionDescriptionInit> {
        throw new Error("createAnswer failed");
      }
    }
    globalThis.RTCPeerConnection = RejectingAnswerPc as unknown as typeof RTCPeerConnection;

    const state = createTransportState();
    state.role = "controller";
    const session = fakeSession();
    state.session = session;

    expect(() =>
      handleSignal(state, cfg, "host_root", { kind: "offer", sdp: "v=0...offer" })
    ).not.toThrow();
    await vi.waitFor(() => expect(state.peers.has("host_root")).toBe(true));
    // createAnswer rejected → no answer was sent back.
    expect(session.send).not.toHaveBeenCalled();
  });

  it("answers with an empty sdp when createAnswer yields no sdp", async () => {
    class NoSdpAnswerPc extends FakePeerConnection {
      override async createAnswer(): Promise<RTCSessionDescriptionInit> {
        return { type: "answer" };
      }
    }
    globalThis.RTCPeerConnection = NoSdpAnswerPc as unknown as typeof RTCPeerConnection;

    const state = createTransportState();
    state.role = "controller";
    const session = fakeSession();
    state.session = session;

    handleSignal(state, cfg, "host_root", { kind: "offer", sdp: "v=0...offer" });
    await vi.waitFor(() => expect(session.send).toHaveBeenCalled());

    const [, msg] = session.send.mock.calls[0] as [string, SignalMsg];
    expect(msg).toEqual({ kind: "answer", sdp: "" });
  });
});
