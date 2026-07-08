/**
 * @file Unit tests for ICE-server resolution (the `IceServersProvider` seam) and the
 * `iceTransportPolicy` passthrough at the single `RTCPeerConnection` construction site.
 * @see ../../ice.ts
 * @see ../../handlers.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomEvents } from "../../../../config";
import { createTransportApi } from "../../api";
import { handlePeerArrival, handlePeerLeave, handleSignal } from "../../handlers";
import { iceServersReady, peekIceServers, primeIceServers } from "../../ice";
import type { IceCandidateInit } from "../../protocol";
import { createTransportState } from "../../state";
import type { PeerConnection, TransportConfig } from "../../types";

/** A no-op `emitWarning` matching the narrowed `room:network-warning` reason closure. */
const noopWarn: (reason: RoomEvents["room:network-warning"]["reason"]) => void = () => {};

/** The default public STUN the fail-open paths must land on. */
const STUN_DEFAULT: readonly RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

/** A distinct TURN-shaped server set a provider resolves with. */
const TURN_SERVERS: readonly RTCIceServer[] = [
  { urls: "turn:turn.example.com:3478", username: "u", credential: "c" }
];

// ─────────────────────────────────────────────────────────────────────────────
// A minimal RTCPeerConnection stand-in that RECORDS its constructor configuration,
// so tests can assert the resolved iceServers + iceTransportPolicy reached the
// single construction site.
// ─────────────────────────────────────────────────────────────────────────────

/** Every configuration passed to `new RTCPeerConnection(...)` during a test, in order. */
const constructedWith: (RTCConfiguration | undefined)[] = [];

class FakePeerConnection {
  iceConnectionState: RTCIceConnectionState = "new";
  remoteDescription: RTCSessionDescriptionInit | null = null;
  readonly addedCandidates: (IceCandidateInit | undefined)[] = [];
  onicecandidate: ((event: { candidate: RTCIceCandidate | null }) => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  ondatachannel: ((event: { channel: RTCDataChannel }) => void) | null = null;

  constructor(configuration?: RTCConfiguration) {
    constructedWith.push(configuration);
  }

  createDataChannel(): RTCDataChannel {
    return { addEventListener: vi.fn(), close: vi.fn() } as unknown as RTCDataChannel;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: "offer", sdp: "v=0...offer" };
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: "answer", sdp: "v=0...answer" };
  }

  async setLocalDescription(): Promise<void> {}

  async setRemoteDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = desc;
  }

  async addIceCandidate(candidate?: IceCandidateInit): Promise<void> {
    this.addedCandidates.push(candidate);
  }

  readonly restartIce = vi.fn();
  close(): void {}
}

/** A full transport config over the given `iceServers` source (defaults mirror production values). */
function makeConfig(iceServers: TransportConfig["iceServers"]): TransportConfig {
  return {
    signaling: { join: vi.fn() },
    iceServers,
    heartbeatIntervalMs: 2000,
    heartbeatTimeoutMs: 6000,
    openTimeoutMs: 3000,
    iceTransportPolicy: "all",
    maxMessageBytes: 14_336
  };
}

/** A session double whose handshake methods are spies. */
function fakeSession() {
  return {
    onPeer: vi.fn(),
    onPeerLeave: vi.fn(),
    onSignal: vi.fn(),
    send: vi.fn(),
    leave: vi.fn().mockResolvedValue(undefined)
  };
}

/** A deferred promise the test resolves by hand (a provider still in flight). */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

let originalRtc: typeof RTCPeerConnection | undefined;
beforeEach(() => {
  originalRtc = globalThis.RTCPeerConnection;
  globalThis.RTCPeerConnection = FakePeerConnection as unknown as typeof RTCPeerConnection;
  constructedWith.length = 0;
});
afterEach(() => {
  if (originalRtc) globalThis.RTCPeerConnection = originalRtc;
  vi.restoreAllMocks();
});

describe("primeIceServers / peekIceServers", () => {
  it("mirrors an array config into state immediately (no provider, no pending)", () => {
    const state = createTransportState();
    const cfg = makeConfig(TURN_SERVERS);

    primeIceServers(state, cfg);

    expect(state.iceServers).toBe(TURN_SERVERS);
    expect(state.icePending).toBeNull();
    expect(peekIceServers(state, cfg)).toBe(TURN_SERVERS);
  });

  it("peek reads an array config directly even without a prime (direct handler call)", () => {
    const state = createTransportState();
    const cfg = makeConfig(TURN_SERVERS);
    expect(peekIceServers(state, cfg)).toBe(TURN_SERVERS);
  });

  it("invokes a provider and stores its resolution; peek is null until it lands", async () => {
    const state = createTransportState();
    const provider = vi.fn().mockResolvedValue(TURN_SERVERS);
    const cfg = makeConfig(provider);

    primeIceServers(state, cfg);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(peekIceServers(state, cfg)).toBeNull();

    await vi.waitFor(() => expect(state.iceServers).toBe(TURN_SERVERS));
    expect(state.icePending).toBeNull();
    expect(peekIceServers(state, cfg)).toBe(TURN_SERVERS);
  });

  it("fails open to the default STUN when the provider resolves undefined", async () => {
    const state = createTransportState();
    const cfg = makeConfig(vi.fn().mockResolvedValue(undefined));

    primeIceServers(state, cfg);
    await vi.waitFor(() => expect(state.iceServers).not.toBeNull());
    expect(state.iceServers).toEqual(STUN_DEFAULT);
  });

  it("fails open to the default STUN when the provider throws", async () => {
    const state = createTransportState();
    const cfg = makeConfig(vi.fn().mockRejectedValue(new Error("endpoint down")));

    primeIceServers(state, cfg);
    await vi.waitFor(() => expect(state.iceServers).not.toBeNull());
    expect(state.iceServers).toEqual(STUN_DEFAULT);
  });

  it("a superseded epoch's late resolution never clobbers the current one", async () => {
    const state = createTransportState();
    const first = deferred<readonly RTCIceServer[] | undefined>();
    const firstCfg = makeConfig(() => first.promise);
    const secondCfg = makeConfig(vi.fn().mockResolvedValue(TURN_SERVERS));

    primeIceServers(state, firstCfg); // epoch 1: still in flight…
    primeIceServers(state, secondCfg); // …superseded by epoch 2
    await vi.waitFor(() => expect(state.iceServers).toBe(TURN_SERVERS));

    first.resolve([{ urls: "stun:stale.example.com" }]); // epoch 1 lands late
    await first.promise;
    expect(state.iceServers).toBe(TURN_SERVERS); // stale write rejected
  });
});

describe("iceServersReady", () => {
  it("resolves immediately for an array config", async () => {
    const state = createTransportState();
    await expect(iceServersReady(state, makeConfig(TURN_SERVERS))).resolves.toBe(TURN_SERVERS);
  });

  it("waits on an in-flight provider and resolves with its servers", async () => {
    const state = createTransportState();
    const gate = deferred<readonly RTCIceServer[] | undefined>();
    const cfg = makeConfig(() => gate.promise);
    primeIceServers(state, cfg);

    const ready = iceServersReady(state, cfg);
    gate.resolve(TURN_SERVERS);
    await expect(ready).resolves.toBe(TURN_SERVERS);
  });

  it("primes defensively when connect() never ran (provider config, direct call)", async () => {
    const state = createTransportState();
    const provider = vi.fn().mockResolvedValue(TURN_SERVERS);

    await expect(iceServersReady(state, makeConfig(provider))).resolves.toBe(TURN_SERVERS);
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("fails open to the default STUN past openTimeoutMs, then stores a late resolution", async () => {
    vi.useFakeTimers();
    try {
      const state = createTransportState();
      const gate = deferred<readonly RTCIceServer[] | undefined>();
      const cfg = makeConfig(() => gate.promise);
      primeIceServers(state, cfg);

      const ready = iceServersReady(state, cfg);
      await vi.advanceTimersByTimeAsync(cfg.openTimeoutMs);
      await expect(ready).resolves.toEqual(STUN_DEFAULT); // bounded wait lost the race

      gate.resolve(TURN_SERVERS); // the hung provider finally lands…
      await vi.waitFor(() => expect(state.iceServers).toBe(TURN_SERVERS));
      // …and subsequent peer creation uses it.
      await expect(iceServersReady(state, cfg)).resolves.toBe(TURN_SERVERS);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("RTCPeerConnection construction — resolved servers + iceTransportPolicy", () => {
  it("host offer path passes the array config and the default 'all' policy", async () => {
    const state = createTransportState();
    state.role = "host";
    state.session = fakeSession();

    handlePeerArrival(state, makeConfig(TURN_SERVERS), "p_ab12", noopWarn);

    expect(constructedWith).toHaveLength(1);
    expect(constructedWith[0]?.iceServers).toEqual(TURN_SERVERS);
    expect(constructedWith[0]?.iceTransportPolicy).toBe("all");
  });

  it("passes 'relay' through to the construction site (deterministic force-relay mode)", () => {
    const state = createTransportState();
    state.role = "host";
    state.session = fakeSession();
    const cfg: TransportConfig = { ...makeConfig(TURN_SERVERS), iceTransportPolicy: "relay" };

    handlePeerArrival(state, cfg, "p_ab12", noopWarn);

    expect(constructedWith[0]?.iceTransportPolicy).toBe("relay");
  });

  it("host offer path defers pc creation until the provider resolves, then uses its servers", async () => {
    const state = createTransportState();
    state.role = "host";
    const session = fakeSession();
    state.session = session;
    const gate = deferred<readonly RTCIceServer[] | undefined>();
    const cfg = makeConfig(() => gate.promise);
    primeIceServers(state, cfg); // connect() primes before peers arrive

    handlePeerArrival(state, cfg, "p_ab12", noopWarn);
    expect(state.peers.has("p_ab12")).toBe(false); // no pc yet — provider in flight
    expect(constructedWith).toHaveLength(0);

    gate.resolve(TURN_SERVERS);
    await vi.waitFor(() => expect(state.peers.has("p_ab12")).toBe(true));
    expect(constructedWith[0]?.iceServers).toEqual(TURN_SERVERS);
    await vi.waitFor(() => expect(session.send).toHaveBeenCalled()); // the offer still goes out
  });

  it("a deferred arrival aborts cleanly when the session tears down while the provider resolves", async () => {
    const state = createTransportState();
    state.role = "host";
    state.session = fakeSession();
    const gate = deferred<readonly RTCIceServer[] | undefined>();
    const cfg = makeConfig(() => gate.promise);
    primeIceServers(state, cfg);

    handlePeerArrival(state, cfg, "p_ab12", noopWarn);
    state.session = null; // torn down mid-wait
    gate.resolve(TURN_SERVERS);
    await state.icePending;

    expect(state.peers.has("p_ab12")).toBe(false);
    expect(constructedWith).toHaveLength(0);
  });

  it("answerer path (inbound offer) waits on the provider and answers with its servers", async () => {
    const state = createTransportState();
    state.role = "controller";
    state.selfId = "p_ab12";
    const session = fakeSession();
    state.session = session;
    const gate = deferred<readonly RTCIceServer[] | undefined>();
    const cfg = makeConfig(() => gate.promise);
    primeIceServers(state, cfg);

    handleSignal(state, cfg, "host_root", { kind: "offer", sdp: "v=0...offer" });
    expect(state.peers.has("host_root")).toBe(false); // answerer deferred on the provider

    gate.resolve(TURN_SERVERS);
    await vi.waitFor(() => expect(session.send).toHaveBeenCalled());
    expect(constructedWith[0]?.iceServers).toEqual(TURN_SERVERS);
  });
});

/** A distinct trickle candidate for the buffering tests. */
function candidateAt(index: number): IceCandidateInit {
  return {
    candidate: `candidate:${index} 1 udp`,
    sdpMid: "0",
    sdpMLineIndex: 0
  };
}

describe("early-candidate buffering (candidates racing the provider wait)", () => {
  it("buffers candidates that arrive before the answerer's pc exists, then flushes after the offer applies", async () => {
    const state = createTransportState();
    state.role = "controller";
    state.selfId = "p_ab12";
    const session = fakeSession();
    state.session = session;
    const gate = deferred<readonly RTCIceServer[] | undefined>();
    const cfg = makeConfig(() => gate.promise);
    primeIceServers(state, cfg);

    // The host's offer arrives, then its trickle — all while the provider is still in flight.
    handleSignal(state, cfg, "host_root", { kind: "offer", sdp: "v=0...offer" });
    handleSignal(state, cfg, "host_root", { kind: "candidate", candidate: candidateAt(1) });
    handleSignal(state, cfg, "host_root", { kind: "candidate", candidate: candidateAt(2) });
    expect(state.earlyCandidates.get("host_root")).toHaveLength(2);

    gate.resolve(TURN_SERVERS);
    await vi.waitFor(() => expect(session.send).toHaveBeenCalled());

    const peer = state.peers.get("host_root") as PeerConnection;
    const pc = peer.pc as unknown as FakePeerConnection;
    // Both buffered candidates were applied after setRemoteDescription, in arrival order.
    await vi.waitFor(() => expect(pc.addedCandidates).toHaveLength(2));
    expect(pc.addedCandidates[0]).toEqual(candidateAt(1));
    expect(state.earlyCandidates.has("host_root")).toBe(false);
  });

  it("caps the per-peer buffer (overflow dropped, same non-fatal contract as out-of-order trickle)", () => {
    const state = createTransportState();
    state.role = "controller";
    state.session = fakeSession();
    const cfg = makeConfig(() => deferred<readonly RTCIceServer[] | undefined>().promise);
    primeIceServers(state, cfg);

    for (let index = 0; index < 40; index += 1) {
      handleSignal(state, cfg, "host_root", { kind: "candidate", candidate: candidateAt(index) });
    }
    expect(state.earlyCandidates.get("host_root")?.length).toBeLessThanOrEqual(16);
  });

  it("clears a peer's buffered candidates when it leaves during the handshake", () => {
    const state = createTransportState();
    state.role = "controller";
    state.session = fakeSession();
    const cfg = makeConfig(() => deferred<readonly RTCIceServer[] | undefined>().promise);
    primeIceServers(state, cfg);

    handleSignal(state, cfg, "host_root", { kind: "candidate", candidate: candidateAt(1) });
    expect(state.earlyCandidates.has("host_root")).toBe(true);

    handlePeerLeave(state, "host_root");
    expect(state.earlyCandidates.has("host_root")).toBe(false);
  });
});

describe("connect() — the provider runs in parallel with the signaling join", () => {
  it("invokes the provider BEFORE awaiting signaling.join, and close() ends the epoch", async () => {
    const state = createTransportState();
    const session = fakeSession();
    const order: string[] = [];
    const provider = vi.fn(async (): Promise<readonly RTCIceServer[] | undefined> => {
      order.push("provider-invoked");
      return TURN_SERVERS;
    });
    const join = vi.fn(async () => {
      order.push("join-awaited");
      return session;
    });
    const cfg: TransportConfig = { ...makeConfig(provider), signaling: { join } };
    const api = createTransportApi(state, cfg, noopWarn);

    await api.connect({ role: "host", selfId: "host_root", code: "K7M2QX" });

    // The provider fired synchronously before the join await — parallel, not serial.
    expect(order).toEqual(["provider-invoked", "join-awaited"]);
    await vi.waitFor(() => expect(state.iceServers).toBe(TURN_SERVERS));

    await api.close();
    expect(state.iceServers).toBeNull(); // epoch ended — the next connect re-primes fresh credentials
    expect(state.icePending).toBeNull();
  });
});
