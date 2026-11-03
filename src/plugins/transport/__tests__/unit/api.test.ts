/**
 * @file Unit tests for the transport API against a mock context.
 * @see ../../api.ts
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTransportApi } from "../../api";
import type { Signaling, SignalingSession } from "../../protocol";
import { RoomFullError } from "../../protocol";
import { createTransportState } from "../../state";
import type { PeerConnection, TransportConfig, TransportState } from "../../types";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** A session double with spy handshake methods. */
function fakeSession(): SignalingSession {
  return {
    onPeer: vi.fn(),
    onPeerLeave: vi.fn(),
    onSignal: vi.fn(),
    send: vi.fn(),
    leave: vi.fn().mockResolvedValue(undefined)
  };
}

/** A Signaling double whose `join` records its opts and returns a fake session. */
function fakeSignaling(session: SignalingSession = fakeSession()): {
  signaling: Signaling;
  join: ReturnType<typeof vi.fn>;
  session: SignalingSession;
} {
  const join = vi.fn().mockResolvedValue(session);
  return { signaling: { join }, join, session };
}

function makeConfig(signaling: Signaling): TransportConfig {
  return {
    signaling,
    iceServers: [],
    heartbeatIntervalMs: 2000,
    heartbeatTimeoutMs: 6000,
    openTimeoutMs: 3000,
    iceTransportPolicy: "all",
    maxMessageBytes: 14_336
  };
}

/** Add a fake connected peer to make `peers()` non-empty. */
function addPeer(
  state: TransportState,
  peerId: string,
  peerState: PeerConnection["state"] = "connected"
): void {
  state.peers.set(peerId, {
    peerId,
    pc: { close: vi.fn() } as unknown as RTCPeerConnection,
    channel: { close: vi.fn(), readyState: "open" } as unknown as RTCDataChannel,
    state: peerState,
    lastPongAt: Date.now(),
    paused: false,
    reassembly: new Map(),
    openTimer: null,
    retries: 0
  });
}

describe("createTransportApi — connect", () => {
  it("connect('host') calls signaling.join with passive:false", async () => {
    const { signaling, join } = fakeSignaling();
    const state = createTransportState();
    const api = createTransportApi(state, makeConfig(signaling), vi.fn());

    await api.connect({ role: "host", selfId: "host_root", code: "K7M2QX" });

    expect(join).toHaveBeenCalledWith("K7M2QX", { selfId: "host_root", passive: false });
    expect(state.role).toBe("host");
    expect(state.selfId).toBe("host_root");
    expect(state.session).not.toBeNull();
  });

  it("connect('controller') calls signaling.join with passive:true", async () => {
    const { signaling, join } = fakeSignaling();
    const state = createTransportState();
    const api = createTransportApi(state, makeConfig(signaling), vi.fn());

    await api.connect({ role: "controller", selfId: "p_ab12", code: "K7M2QX" });

    expect(join).toHaveBeenCalledWith("K7M2QX", { selfId: "p_ab12", passive: true });
    expect(state.role).toBe("controller");
  });

  it("wires the session handshake callbacks (onPeer/onSignal/onPeerLeave)", async () => {
    const session = fakeSession();
    const { signaling } = fakeSignaling(session);
    const state = createTransportState();
    const api = createTransportApi(state, makeConfig(signaling), vi.fn());

    await api.connect({ role: "host", selfId: "host_root", code: "K7M2QX" });

    expect(session.onPeer).toHaveBeenCalledOnce();
    expect(session.onSignal).toHaveBeenCalledOnce();
    expect(session.onPeerLeave).toHaveBeenCalledOnce();
  });

  it("resolves once the session is live (not once peers connect)", async () => {
    const { signaling } = fakeSignaling();
    const state = createTransportState();
    const api = createTransportApi(state, makeConfig(signaling), vi.fn());

    await api.connect({ role: "host", selfId: "host_root", code: "K7M2QX" });
    // No peers required for connect to resolve.
    expect(state.peers.size).toBe(0);
  });

  it("rejects + emits 'rendezvous-unreachable' when no relay is reachable", async () => {
    const join = vi.fn().mockRejectedValue(new Error("no relays"));
    const emitWarning = vi.fn();
    const state = createTransportState();
    const api = createTransportApi(state, makeConfig({ join }), emitWarning);

    await expect(
      api.connect({ role: "host", selfId: "host_root", code: "K7M2QX" })
    ).rejects.toThrow();
    expect(emitWarning).toHaveBeenCalledWith("rendezvous-unreachable");
  });

  it("rethrows RoomFullError with no warning: fullness is a result, not an event", async () => {
    const join = vi.fn().mockRejectedValue(new RoomFullError());
    const emitWarning = vi.fn();
    const state = createTransportState();
    const api = createTransportApi(state, makeConfig({ join }), emitWarning);

    await expect(
      api.connect({ role: "controller", selfId: "p_ab12", code: "K7M2QX" })
    ).rejects.toBeInstanceOf(RoomFullError);
    expect(emitWarning).not.toHaveBeenCalled();
  });

  it("a join that lands after close() releases its session and leaves nothing live", async () => {
    const session = fakeSession();
    let land: ((value: SignalingSession) => void) | undefined;
    const join = vi.fn(
      () =>
        new Promise<SignalingSession>(resolve => {
          land = resolve;
        })
    );
    const state = createTransportState();
    const api = createTransportApi(state, makeConfig({ join }), vi.fn());

    const connecting = api.connect({ role: "controller", selfId: "p_ab12", code: "K7M2QX" });
    await api.close();
    land?.(session);
    await connecting;

    expect(session.leave).toHaveBeenCalledOnce();
    expect(session.onPeer).not.toHaveBeenCalled();
    expect(state.session).toBeNull();
    expect(state.heartbeatTimer).toBeNull();
  });

  it("is idempotent: a second connect leaves the prior session instead of leaking it", async () => {
    const first = fakeSession();
    const second = fakeSession();
    const join = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const state = createTransportState();
    const api = createTransportApi(state, makeConfig({ join }), vi.fn());

    await api.connect({ role: "host", selfId: "host_root", code: "K7M2QX" });
    expect(state.session).toBe(first);

    await api.connect({ role: "host", selfId: "host_root", code: "K7M2QX" });

    // The prior session was released before the new one was installed (no leak).
    expect(first.leave).toHaveBeenCalledTimes(1);
    expect(state.session).toBe(second);
  });
});

describe("createTransportApi — wire / peers / disconnect / close", () => {
  it("wire() returns the same stable Wire instance every call", () => {
    const { signaling } = fakeSignaling();
    const api = createTransportApi(createTransportState(), makeConfig(signaling), vi.fn());
    expect(api.wire()).toBe(api.wire());
  });

  it("peers() reflects the live peer map (connected only)", () => {
    const { signaling } = fakeSignaling();
    const state = createTransportState();
    addPeer(state, "p1", "connected");
    addPeer(state, "p2", "connecting");
    const api = createTransportApi(state, makeConfig(signaling), vi.fn());

    expect(api.peers()).toEqual(["p1"]);
  });

  it("peers() returns an empty array when nothing is connected", () => {
    const { signaling } = fakeSignaling();
    const api = createTransportApi(createTransportState(), makeConfig(signaling), vi.fn());
    expect(api.peers()).toEqual([]);
  });

  it("disconnect removes exactly one peer", () => {
    const { signaling } = fakeSignaling();
    const state = createTransportState();
    addPeer(state, "p1");
    addPeer(state, "p2");
    const api = createTransportApi(state, makeConfig(signaling), vi.fn());

    api.disconnect("p1");
    expect(state.peers.has("p1")).toBe(false);
    expect(state.peers.has("p2")).toBe(true);
  });

  it("close() leaves the signaling session and clears state", async () => {
    const session = fakeSession();
    const { signaling } = fakeSignaling(session);
    const state = createTransportState();
    const api = createTransportApi(state, makeConfig(signaling), vi.fn());

    await api.connect({ role: "host", selfId: "host_root", code: "K7M2QX" });
    addPeer(state, "p1");

    await api.close();

    expect(session.leave).toHaveBeenCalledTimes(1);
    expect(state.peers.size).toBe(0);
    expect(state.session).toBeNull();
  });

  it("close() keeps the peer callbacks and the wire consumers for the next connect()", async () => {
    const { signaling } = fakeSignaling();
    const state = createTransportState();
    const api = createTransportApi(state, makeConfig(signaling), vi.fn());
    const onConnected = vi.fn();
    const onLost = vi.fn();
    const onFrame = vi.fn();
    api.onPeerConnected(onConnected);
    api.onPeerLost(onLost);
    api.wire().on(onFrame);
    await api.connect({ role: "host", selfId: "host_root", code: "K7M2QX" });

    await api.close();

    expect(state.peerConnectedCb).toBe(onConnected);
    expect(state.peerLostCb).toBe(onLost);
    expect(state.frameConsumers.has(onFrame)).toBe(true);
  });

  it("close() is idempotent when already closed", async () => {
    const { signaling } = fakeSignaling();
    const api = createTransportApi(createTransportState(), makeConfig(signaling), vi.fn());
    await expect(api.close()).resolves.toBeUndefined();
    await expect(api.close()).resolves.toBeUndefined();
  });
});

/** The placeholder until a promise hands over its resolver. */
const noResolverYet = (): void => {};

describe("createTransportApi — a connect during a close", () => {
  it("createRoom while the last session still leaves: the new connect keeps role host and its selfId", async () => {
    const leaving = fakeSession();
    let finishLeave = noResolverYet;
    vi.mocked(leaving.leave).mockReturnValue(
      new Promise<void>(resolve => {
        finishLeave = resolve;
      })
    );
    const { signaling, join } = fakeSignaling();
    join.mockResolvedValueOnce(leaving);
    const state = createTransportState();
    const api = createTransportApi(state, makeConfig(signaling), vi.fn());
    await api.connect({ role: "controller", selfId: "old", code: "AAAAAA" });

    const closing = api.close();
    await api.connect({ role: "host", selfId: "new", code: "BBBBBB" });
    finishLeave();
    await closing;

    expect(state.role).toBe("host");
    expect(state.selfId).toBe("new");
  });
});

describe("createTransportApi — onPeerConnected / onPeerLost (D18 seam)", () => {
  it("onPeerConnected sets state.peerConnectedCb to the supplied callback", () => {
    const { signaling } = fakeSignaling();
    const state = createTransportState();
    const api = createTransportApi(state, makeConfig(signaling), vi.fn());

    const cb = vi.fn();
    api.onPeerConnected(cb);

    expect(state.peerConnectedCb).toBe(cb);
  });

  it("onPeerConnected returns an unsubscribe that clears the cb when it is still active", () => {
    const { signaling } = fakeSignaling();
    const state = createTransportState();
    const api = createTransportApi(state, makeConfig(signaling), vi.fn());

    const cb = vi.fn();
    const off = api.onPeerConnected(cb);
    expect(state.peerConnectedCb).toBe(cb);

    off();
    expect(state.peerConnectedCb).toBeNull();
  });

  it("onPeerConnected unsubscribe is a no-op if a later registration replaced the cb", () => {
    const { signaling } = fakeSignaling();
    const state = createTransportState();
    const api = createTransportApi(state, makeConfig(signaling), vi.fn());

    const first = vi.fn();
    const second = vi.fn();
    const offFirst = api.onPeerConnected(first);
    api.onPeerConnected(second);

    // offFirst was superseded — calling it must not clear the newer cb.
    offFirst();
    expect(state.peerConnectedCb).toBe(second);
  });

  it("onPeerLost sets state.peerLostCb to the supplied callback", () => {
    const { signaling } = fakeSignaling();
    const state = createTransportState();
    const api = createTransportApi(state, makeConfig(signaling), vi.fn());

    const cb = vi.fn();
    api.onPeerLost(cb);

    expect(state.peerLostCb).toBe(cb);
  });

  it("onPeerLost returns an unsubscribe that clears the cb when it is still active", () => {
    const { signaling } = fakeSignaling();
    const state = createTransportState();
    const api = createTransportApi(state, makeConfig(signaling), vi.fn());

    const cb = vi.fn();
    const off = api.onPeerLost(cb);
    expect(state.peerLostCb).toBe(cb);

    off();
    expect(state.peerLostCb).toBeNull();
  });

  it("onPeerLost unsubscribe is a no-op if a later registration replaced the cb", () => {
    const { signaling } = fakeSignaling();
    const state = createTransportState();
    const api = createTransportApi(state, makeConfig(signaling), vi.fn());

    const first = vi.fn();
    const second = vi.fn();
    const offFirst = api.onPeerLost(first);
    api.onPeerLost(second);

    offFirst();
    expect(state.peerLostCb).toBe(second);
  });
});
