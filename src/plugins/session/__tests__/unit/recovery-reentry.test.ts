/**
 * @file Unit tests for `recovery/reentry.ts`: the `onInit` transport wiring + host-reload re-entry.
 * Covers `registerTransportBindings` (role-discriminated onPeerConnected/onPeerLost callbacks + the
 * finding-#1 stable-host guard + the Wire.on recovery router), `doJoinRoom` (roster admission / timeout /
 * connect-reject / pre-existing-timeout clear), `rejoinSameRoom` (throws without a stored code), and
 * `detectHostReload` (no-record no-op + the full record-hit restore path with `persistence` mocked).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { RoomFullError } from "../../../transport/protocol";
import { createSessionApi } from "../../api";
import * as persistence from "../../recovery/persistence";
import type { SessionStateWithRuntime } from "../../recovery/reentry";
import {
  detectHostReload,
  doJoinRoom,
  registerTransportBindings,
  rejoinSameRoom
} from "../../recovery/reentry";
import { createSessionState } from "../../state";
import type { HostReentryRecord, SessionConfig, SessionDeps } from "../../types";

const testConfig: Readonly<SessionConfig> = {
  joinUrlBase: "",
  generateQr: false,
  maxControllers: 8,
  snapshotDebounceMs: 500,
  reconnectTimeoutMs: 200, // short for tests
  intentBufferMax: 256,
  intentBufferMaxAgeMs: 8000,
  storageKeyPrefix: "test.room",
  reentryMaxAgeMs: 1_800_000
};

// Captured transport callbacks — populated when registerTransportBindings runs against the mock.
let onPeerConnectedCb: ((peerId: string) => void) | undefined;
let onPeerLostCb: ((peerId: string) => void) | undefined;
let wireOnCb: ((peerId: string, frame: unknown) => void) | undefined;

/** The unsubscribe thunk every `onPeerConnected`/`onPeerLost` registration returns (unused by reentry). */
const noopUnsubscribe = (): void => {};

function makeDeps(state = createSessionState(), connectImpl?: () => Promise<void>): SessionDeps {
  onPeerConnectedCb = undefined;
  onPeerLostCb = undefined;
  wireOnCb = undefined;

  const mockWire = {
    send: vi.fn(),
    broadcast: vi.fn(),
    on: vi.fn((cb: (peerId: string, frame: unknown) => void) => {
      wireOnCb = cb;
    })
  };

  const mockTransport = {
    connect: vi.fn(connectImpl ?? (() => Promise.resolve(undefined))),
    wire: vi.fn().mockReturnValue(mockWire),
    disconnect: vi.fn(),
    peers: vi.fn().mockReturnValue([]),
    close: vi.fn().mockResolvedValue(undefined),
    onPeerConnected: vi.fn((cb: (peerId: string) => void) => {
      onPeerConnectedCb = cb;
      return noopUnsubscribe;
    }),
    onPeerLost: vi.fn((cb: (peerId: string) => void) => {
      onPeerLostCb = cb;
      return noopUnsubscribe;
    })
  };

  return {
    state,
    config: testConfig,
    emit: { peerJoined: vi.fn(), peerLeft: vi.fn(), hostReconnecting: vi.fn(), hostBack: vi.fn() },
    log: { warn: vi.fn() },
    requireTransport: vi.fn().mockReturnValue(mockTransport)
  };
}

function runtime(deps: SessionDeps): SessionStateWithRuntime {
  return deps.state as unknown as SessionStateWithRuntime;
}

/** The host's roster broadcast that admits `selfId`, as the session's `Wire.on` router receives it. */
function deliverRoster(selfId: string): void {
  wireOnCb?.("host-1", {
    t: "roster",
    roster: { [selfId]: { id: selfId, joinedAt: 1 } }
  });
}

/** A fresh state for a controller whose id is already minted, as `joinRoom` leaves it. */
function stateWithSelfId(): ReturnType<typeof createSessionState> {
  const state = createSessionState();
  state.selfId = "me";
  return state;
}

describe("recovery/reentry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("registerTransportBindings — onPeerConnected", () => {
    it("host branch: a connecting peer upserts a roster entry", () => {
      const state = createSessionState();
      state.role = "host";
      const deps = makeDeps(state);

      registerTransportBindings(deps);
      expect(onPeerConnectedCb).toBeDefined();

      onPeerConnectedCb?.("p-1");

      expect(deps.state.roster["p-1"]).toBeDefined();
      expect(deps.state.roster["p-1"]?.id).toBe("p-1");
      expect(deps.emit.peerJoined).toHaveBeenCalledWith({ peerId: "p-1" });
    });

    it("controller branch with a pending join: records the host, phase stable, stays pending until the roster frame", async () => {
      const deps = makeDeps(stateWithSelfId());

      registerTransportBindings(deps);

      // doJoinRoom installs the pending resolver + flips role to controller.
      const joinPromise = doJoinRoom(deps, "TEST01");

      onPeerConnectedCb?.("host-1");

      // The open channel records the host, and settles nothing: a full host opens the channel too.
      expect(runtime(deps)._hostId).toBe("host-1");
      expect(deps.state.recovery.phase).toBe("stable");
      expect(runtime(deps)._pendingJoinResolve).not.toBeNull();

      deliverRoster("me");

      await expect(joinPromise).resolves.toEqual({ ok: true, selfId: "me" });
      expect(runtime(deps)._pendingJoinResolve).toBeNull();
    });

    it("controller branch guard (finding #1): stable + known host + no pending resolve does NOT clobber _hostId", () => {
      const state = createSessionState();
      state.role = "controller";
      state.recovery.phase = "stable";
      const deps = makeDeps(state);

      registerTransportBindings(deps);

      const rt = runtime(deps);
      rt._hostId = "host-original";
      rt._pendingJoinResolve = null;
      vi.mocked(deps.requireTransport().peers).mockReturnValue(["host-original"]);

      // A DIFFERENT peer surfaces while stable — must be ignored (not a second host).
      onPeerConnectedCb?.("controller-2");

      expect(rt._hostId).toBe("host-original");
      expect(deps.emit.hostReconnecting).not.toHaveBeenCalled();
      expect(deps.emit.hostBack).not.toHaveBeenCalled();
    });

    it("stable, and the known host is no longer connected: a new peer runs the host-absent entry, then back", () => {
      vi.useFakeTimers();
      try {
        const state = createSessionState();
        state.role = "controller";
        const deps = makeDeps(state);
        registerTransportBindings(deps);
        const rt = runtime(deps);
        rt._hostId = "host-old";
        vi.mocked(deps.requireTransport().peers).mockReturnValue(["host-new"]);

        onPeerConnectedCb?.("host-new");

        expect(rt._hostId).toBe("host-new");
        expect(deps.state.recovery.phase).toBe("stable");
        expect(deps.emit.hostReconnecting).toHaveBeenCalledOnce();
        expect(deps.emit.hostBack).toHaveBeenCalledOnce();
        expect(deps.state.recovery.timer).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("a first join after an old room's leave() fires neither recovery event, whatever _hostId still holds", async () => {
      const deps = makeDeps(stateWithSelfId());
      registerTransportBindings(deps);
      runtime(deps)._hostId = "host-of-the-old-room";

      const joinPromise = doJoinRoom(deps, "TEST01");
      onPeerConnectedCb?.("host-1");
      deliverRoster("me");
      await joinPromise;

      expect(runtime(deps)._hostId).toBe("host-1");
      expect(deps.emit.hostReconnecting).not.toHaveBeenCalled();
      expect(deps.emit.hostBack).not.toHaveBeenCalled();
    });

    it("the host comes back in time: back fires once, and the reconnect timer never rejoins behind it", async () => {
      vi.useFakeTimers();
      try {
        const state = createSessionState();
        state.role = "controller";
        state.roomCode = "TEST01";
        const deps = makeDeps(state);
        registerTransportBindings(deps);
        const rt = runtime(deps);
        rt._hostId = "host-old";

        onPeerLostCb?.("host-old");
        expect(deps.state.recovery.phase).toBe("host-absent");
        expect(deps.emit.hostBack).not.toHaveBeenCalled();

        onPeerConnectedCb?.("host-new");

        expect(deps.emit.hostBack).toHaveBeenCalledOnce();
        expect(deps.state.recovery.timer).toBeNull();
        expect(deps.state.recovery.reconnectDeadline).toBe(0);

        await vi.advanceTimersByTimeAsync(testConfig.reconnectTimeoutMs * 2);
        expect(vi.mocked(deps.requireTransport().connect)).not.toHaveBeenCalled();
        expect(deps.state.recovery.phase).toBe("stable");
      } finally {
        vi.useRealTimers();
      }
    });

    it("controller branch during recovery (host-absent): a new host id updates _hostId + phase stable", () => {
      const state = createSessionState();
      state.role = "controller";
      state.recovery.phase = "host-absent"; // expectingHost === true
      const deps = makeDeps(state);

      registerTransportBindings(deps);

      const rt = runtime(deps);
      rt._hostId = "host-old";
      rt._pendingJoinResolve = null;

      onPeerConnectedCb?.("host-new");

      expect(rt._hostId).toBe("host-new");
      expect(deps.state.recovery.phase).toBe("stable");
    });

    it("controller branch keeps an already-set selfId rather than adopting the peer id", () => {
      const state = createSessionState();
      state.role = "controller";
      state.selfId = "my-own-id";
      state.recovery.phase = "host-absent";
      const deps = makeDeps(state);

      registerTransportBindings(deps);
      runtime(deps)._hostId = null;

      onPeerConnectedCb?.("host-new");

      // selfId is preserved (the `selfId || peerId` branch keeps the existing value).
      expect(deps.state.selfId).toBe("my-own-id");
      expect(runtime(deps)._hostId).toBe("host-new");
    });
  });

  describe("registerTransportBindings — onPeerLost", () => {
    it("host branch: a lost peer is removed from the roster", () => {
      const state = createSessionState();
      state.role = "host";
      const deps = makeDeps(state);

      registerTransportBindings(deps);

      // Add a roster entry via the connected callback first.
      onPeerConnectedCb?.("p-1");
      expect(deps.state.roster["p-1"]).toBeDefined();

      onPeerLostCb?.("p-1");

      expect(deps.state.roster["p-1"]).toBeUndefined();
      expect(deps.emit.peerLeft).toHaveBeenCalledWith({ peerId: "p-1" });
    });

    it("controller branch: losing the host peer enters host-absent + arms a timer", () => {
      vi.useFakeTimers();
      try {
        const state = createSessionState();
        state.role = "controller";
        state.roomCode = "TEST01";
        const deps = makeDeps(state);

        registerTransportBindings(deps);
        runtime(deps)._hostId = "host-1";

        onPeerLostCb?.("host-1");

        expect(deps.state.recovery.phase).toBe("host-absent");
        expect(deps.state.recovery.timer).not.toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("controller branch: losing a non-host peer is a no-op", () => {
      const state = createSessionState();
      state.role = "controller";
      const deps = makeDeps(state);

      registerTransportBindings(deps);
      runtime(deps)._hostId = "host-1";

      onPeerLostCb?.("some-other-peer");

      expect(deps.state.recovery.phase).toBe("stable");
    });

    it("controller branch: lost peer with no known host (_hostId null) is a no-op", () => {
      const state = createSessionState();
      state.role = "controller";
      const deps = makeDeps(state);

      registerTransportBindings(deps);
      // _hostId stays undefined/null — the `rt._hostId && ...` guard short-circuits.

      onPeerLostCb?.("host-1");

      expect(deps.state.recovery.phase).toBe("stable");
    });
  });

  describe("registerTransportBindings — wire().on router", () => {
    it("registers the recovery-frame handler on the wire", () => {
      const deps = makeDeps();
      registerTransportBindings(deps);

      const transport = deps.requireTransport();
      expect(vi.mocked(transport.wire().on)).toHaveBeenCalledTimes(1);
      expect(wireOnCb).toBeDefined();

      // The router is a real handler — driving a non-recovery frame must not throw.
      expect(() => wireOnCb?.("p-1", { t: "ping", ts: 0 })).not.toThrow();
    });
  });

  describe("doJoinRoom", () => {
    it("SUCCESS: resolves { ok: true, selfId } when the host's roster frame admits this device", async () => {
      const deps = makeDeps(stateWithSelfId());
      registerTransportBindings(deps);

      const joinPromise = doJoinRoom(deps, "TEST01");
      expect(deps.state.roomCode).toBe("TEST01");
      expect(deps.state.role).toBe("controller");

      onPeerConnectedCb?.("host-1");
      deliverRoster("me");

      await expect(joinPromise).resolves.toEqual({ ok: true, selfId: "me" });
    });

    it("TIMEOUT: resolves { ok: false, reason: unreachable } after reconnectTimeoutMs", async () => {
      vi.useFakeTimers();
      try {
        const deps = makeDeps();
        const joinPromise = doJoinRoom(deps, "TEST01");

        await vi.advanceTimersByTimeAsync(testConfig.reconnectTimeoutMs + 10);

        await expect(joinPromise).resolves.toEqual({ ok: false, reason: "unreachable" });
        expect(runtime(deps)._pendingJoinResolve).toBeNull();
        expect(runtime(deps)._joinTimeout).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("room-full settles first: a roster frame after it does nothing", async () => {
      const deps = makeDeps(stateWithSelfId());
      registerTransportBindings(deps);

      const joinPromise = doJoinRoom(deps, "TEST01");
      wireOnCb?.("host-1", { t: "room-full" });
      deliverRoster("me");

      await expect(joinPromise).resolves.toEqual({ ok: false, reason: "full" });
      expect(deps.state.role).toBe("none");
      expect(deps.state.roster).toEqual({});
      expect(vi.mocked(deps.requireTransport().close)).toHaveBeenCalledOnce();
    });

    it("a roster frame keyed by another id admits too: publicRendezvous keys it by Trystero's id", async () => {
      const deps = makeDeps(stateWithSelfId());
      registerTransportBindings(deps);

      const joinPromise = doJoinRoom(deps, "TEST01");
      deliverRoster("trystero-peer-id");

      await expect(joinPromise).resolves.toEqual({ ok: true, selfId: "me" });
    });

    it("CONNECT REJECTS with RoomFullError: resolves full and resets the room state", async () => {
      const deps = makeDeps(stateWithSelfId(), () => Promise.reject(new RoomFullError()));

      const result = await doJoinRoom(deps, "TEST01");

      expect(result).toEqual({ ok: false, reason: "full" });
      expect(deps.state.role).toBe("none");
      expect(deps.state.roomCode).toBe("");
      expect(vi.mocked(deps.requireTransport().close)).toHaveBeenCalledOnce();
    });

    it("LOST room-full frame: the channel opens, no frame comes, ends unreachable with nothing stale", async () => {
      vi.useFakeTimers();
      try {
        const deps = makeDeps(stateWithSelfId());
        registerTransportBindings(deps);

        const joinPromise = doJoinRoom(deps, "TEST01");
        onPeerConnectedCb?.("host-1");
        expect(runtime(deps)._hostId).toBe("host-1");

        // The host disconnected this device, so the heartbeat declares it dead before the join times out.
        onPeerLostCb?.("host-1");
        expect(deps.state.recovery.phase).toBe("host-absent");

        await vi.advanceTimersByTimeAsync(testConfig.reconnectTimeoutMs + 10);

        await expect(joinPromise).resolves.toEqual({ ok: false, reason: "unreachable" });
        expect(deps.state.role).toBe("none");
        expect(deps.state.roomCode).toBe("");
        expect(runtime(deps)._hostId).toBeNull();
        expect(deps.state.recovery.phase).toBe("stable");
        expect(deps.state.recovery.timer).toBeNull();
        expect(vi.mocked(deps.requireTransport().close)).toHaveBeenCalledOnce();

        // No auto-rejoin fires later on behalf of the failed join.
        await vi.advanceTimersByTimeAsync(testConfig.reconnectTimeoutMs * 2);
        expect(vi.mocked(deps.requireTransport().connect)).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
    });

    it("a failed join resolves only after the close finished, so a retry cannot race the teardown", async () => {
      const deps = makeDeps(stateWithSelfId(), () => Promise.reject(new Error("boom")));
      let finishClose: (() => void) | undefined;
      vi.mocked(deps.requireTransport().close).mockImplementation(
        () =>
          new Promise<void>(resolve => {
            finishClose = resolve;
          })
      );
      const settled = vi.fn();

      const joinPromise = doJoinRoom(deps, "TEST01").then(settled);
      await vi.waitFor(() => {
        expect(vi.mocked(deps.requireTransport().close)).toHaveBeenCalledOnce();
      });
      expect(settled).not.toHaveBeenCalled();

      finishClose?.();
      await joinPromise;

      expect(settled).toHaveBeenCalledWith({ ok: false, reason: "not-found" });
    });

    it("a failed first join calls onRoomEnded in the stable phase too, once, by the time the caller has the result", async () => {
      const deps = makeDeps(stateWithSelfId(), () => Promise.reject(new Error("boom")));
      const ended = vi.fn();
      createSessionApi(deps).onRoomEnded(ended);

      const calledByResult = await doJoinRoom(deps, "TEST01").then(() => ended.mock.calls.length);

      expect(calledByResult).toBe(1);
      expect(deps.emit.hostBack).not.toHaveBeenCalled();
    });

    it("a successful join does not call onRoomEnded", async () => {
      const deps = makeDeps(stateWithSelfId());
      registerTransportBindings(deps);
      const ended = vi.fn();
      createSessionApi(deps).onRoomEnded(ended);

      const joining = doJoinRoom(deps, "TEST01");
      onPeerConnectedCb?.("host-1");
      deliverRoster("me");
      await joining;

      expect(ended).not.toHaveBeenCalled();
    });

    it("a failed rejoin keeps the room, so it does not call onRoomEnded", async () => {
      const state = stateWithSelfId();
      state.role = "controller";
      state.roomCode = "TEST01";
      const deps = makeDeps(state, () => Promise.reject(new Error("boom")));
      const ended = vi.fn();
      createSessionApi(deps).onRoomEnded(ended);

      await expect(rejoinSameRoom(deps)).resolves.toEqual({ ok: false, reason: "not-found" });

      expect(ended).not.toHaveBeenCalled();
    });

    it("a failed rejoin keeps the room: the host that comes back later is still adopted", async () => {
      vi.useFakeTimers();
      try {
        const state = stateWithSelfId();
        state.role = "controller";
        state.roomCode = "TEST01";
        state.recovery.phase = "host-absent";
        const deps = makeDeps(state);
        registerTransportBindings(deps);

        const rejoining = rejoinSameRoom(deps);
        await vi.advanceTimersByTimeAsync(testConfig.reconnectTimeoutMs + 10);

        await expect(rejoining).resolves.toEqual({ ok: false, reason: "unreachable" });
        expect(deps.state.role).toBe("controller");
        expect(deps.state.roomCode).toBe("TEST01");
        expect(vi.mocked(deps.requireTransport().close)).not.toHaveBeenCalled();

        onPeerConnectedCb?.("host-back");

        expect(runtime(deps)._hostId).toBe("host-back");
        expect(deps.state.recovery.phase).toBe("stable");
      } finally {
        vi.useRealTimers();
      }
    });

    it("CONNECT REJECTS: resolves { ok: false, reason: not-found }", async () => {
      vi.useFakeTimers();
      try {
        const deps = makeDeps(createSessionState(), () => Promise.reject(new Error("boom")));

        const result = await doJoinRoom(deps, "TEST01");

        expect(result).toEqual({ ok: false, reason: "not-found" });
        // The reject handler clears the pending resolver + the join timeout.
        expect(runtime(deps)._pendingJoinResolve).toBeNull();
        expect(runtime(deps)._joinTimeout).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("timeout firing AFTER a successful resolve is a no-op (defensive double-resolve guard)", async () => {
      vi.useFakeTimers();
      try {
        const deps = makeDeps(stateWithSelfId());
        registerTransportBindings(deps);

        const joinPromise = doJoinRoom(deps, "TEST01");

        // Resolve via the roster frame — this nulls _pendingJoinResolve.
        deliverRoster("me");
        await expect(joinPromise).resolves.toEqual({ ok: true, selfId: "me" });

        // Now let the original timeout elapse. It was cleared on settle, so it must NOT re-resolve /
        // overwrite the result.
        await vi.advanceTimersByTimeAsync(testConfig.reconnectTimeoutMs + 10);

        // No second resolution occurred (promise already settled to ok:true) and state is clean.
        await expect(joinPromise).resolves.toEqual({ ok: true, selfId: "me" });
        expect(deps.state.role).toBe("controller");
        expect(runtime(deps)._pendingJoinResolve).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("connect rejecting AFTER a successful resolve is a no-op (resolver no longer matches)", async () => {
      vi.useFakeTimers();
      try {
        // A connect whose rejection we control, so it lands AFTER the roster-frame resolve.
        let rejectConnect: ((reason: unknown) => void) | undefined;
        const deps = makeDeps(
          stateWithSelfId(),
          () =>
            new Promise<void>((_resolve, reject) => {
              rejectConnect = reject;
            })
        );
        registerTransportBindings(deps);

        const joinPromise = doJoinRoom(deps, "TEST01");

        // Resolve first via the roster frame.
        deliverRoster("me");
        await expect(joinPromise).resolves.toEqual({ ok: true, selfId: "me" });

        // Now reject connect — nothing is pending any more, so the "not-found" path is skipped (no
        // overwrite of the already-resolved ok:true result, no reset of the joined state).
        rejectConnect?.(new Error("late reject"));
        await Promise.resolve();
        await Promise.resolve();

        await expect(joinPromise).resolves.toEqual({ ok: true, selfId: "me" });
        expect(deps.state.role).toBe("controller");
      } finally {
        vi.useRealTimers();
      }
    });

    it("clears a pre-existing _joinTimeout before arming a new one", async () => {
      vi.useFakeTimers();
      const clearSpy = vi.spyOn(globalThis, "clearTimeout");
      try {
        const deps = makeDeps(stateWithSelfId());
        registerTransportBindings(deps);

        // First join arms a timeout; capture the handle before it fires.
        const firstPromise = doJoinRoom(deps, "ROOM-A");
        const firstTimeout = runtime(deps)._joinTimeout;
        expect(firstTimeout).not.toBeNull();

        // Second join (same state) must clearTimeout(firstTimeout) and arm a fresh handle.
        const secondPromise = doJoinRoom(deps, "ROOM-B");
        const secondTimeout = runtime(deps)._joinTimeout;
        expect(secondTimeout).not.toBe(firstTimeout);
        expect(clearSpy).toHaveBeenCalledWith(firstTimeout);

        // The second join owns the live resolver — settle it via the roster frame (it resolves
        // whichever resolver is currently pending), then drain the now-cleared first timeout so
        // nothing dangles.
        deliverRoster("me");
        await expect(secondPromise).resolves.toEqual({ ok: true, selfId: "me" });

        // The first resolver was overwritten before it ever ran; its promise never settles, and its
        // timeout was cleared above so it cannot fire. Attach a no-op catch so the floating promise
        // is explicitly handled (we intentionally never await it).
        firstPromise.catch(noopUnsubscribe);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("rejoinSameRoom", () => {
    it("throws when there is no stored roomCode", () => {
      const state = createSessionState();
      state.roomCode = "";
      const deps = makeDeps(state);

      expect(() => rejoinSameRoom(deps)).toThrow(/Cannot rejoin/);
    });

    it("calls doJoinRoom with the stored roomCode when set", async () => {
      vi.useFakeTimers();
      try {
        const state = createSessionState();
        state.roomCode = "STORED";
        const deps = makeDeps(state);

        const promise = rejoinSameRoom(deps);

        const transport = deps.requireTransport();
        expect(vi.mocked(transport.connect)).toHaveBeenCalledWith(
          expect.objectContaining({ role: "controller", code: "STORED" })
        );

        // Settle the pending join so it does not dangle.
        await vi.advanceTimersByTimeAsync(testConfig.reconnectTimeoutMs + 10);
        await expect(promise).resolves.toEqual({ ok: false, reason: "unreachable" });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("detectHostReload", () => {
    it("no record: no-op (role stays none, no connect, no event)", () => {
      // In bun/node there is no localStorage, so readReentryRecord returns null.
      const deps = makeDeps();

      detectHostReload(deps);

      expect(deps.state.role).toBe("none");
      expect(deps.emit.hostReconnecting).not.toHaveBeenCalled();
      const transport = deps.requireTransport();
      expect(vi.mocked(transport.connect)).not.toHaveBeenCalled();
    });

    it("with a record: restores host state, emits hostReconnecting, reconnects with role host", () => {
      const record: HostReentryRecord = {
        roomCode: "RELOAD",
        hostToken: "tok-xyz",
        snapshot: {},
        sSeq: 42,
        savedAt: 1_700_000_000_000
      };

      const fakeHandle = {
        flushNow: vi.fn(),
        dispose: vi.fn(),
        discard: vi.fn(),
        _update: vi.fn()
      };
      const readSpy = vi.spyOn(persistence, "readReentryRecord").mockReturnValue(record);
      const armSpy = vi.spyOn(persistence, "armPersistence").mockReturnValue(fakeHandle);

      const deps = makeDeps();

      detectHostReload(deps);

      // Host identity restored from the record.
      expect(deps.state.role).toBe("host");
      expect(deps.state.roomCode).toBe("RELOAD");
      expect(deps.state.hostToken).toBe("tok-xyz");
      expect(deps.state.sSeqAtSnapshot).toBe(42);
      expect(deps.state.selfId).not.toBe(""); // a fresh host selfId was minted

      // The record is retained for re-broadcast + persistence re-armed.
      expect(runtime(deps)._reentryRecord).toBe(record);
      expect(deps.state.recovery.persistHandle).toBe(fakeHandle);
      expect(armSpy).toHaveBeenCalledWith(deps);

      // The host-reconnecting signal fired.
      expect(deps.emit.hostReconnecting).toHaveBeenCalledWith({});

      // Transport was told to rejoin the SAME room code as a host.
      const transport = deps.requireTransport();
      expect(vi.mocked(transport.connect)).toHaveBeenCalledWith(
        expect.objectContaining({ role: "host", code: "RELOAD", selfId: deps.state.selfId })
      );

      expect(readSpy).toHaveBeenCalledWith(deps);
    });

    it("with a serverSignaling record: replays the reclaim token into transport.connect", () => {
      const record: HostReentryRecord = {
        roomCode: "RELOADX",
        hostToken: "tok-h",
        snapshot: {},
        sSeq: 3,
        savedAt: 1_700_000_000_003,
        reclaimToken: "tok-DO"
      };
      vi.spyOn(persistence, "readReentryRecord").mockReturnValue(record);
      vi.spyOn(persistence, "armPersistence").mockReturnValue({
        flushNow: vi.fn(),
        dispose: vi.fn(),
        discard: vi.fn(),
        _update: vi.fn()
      });

      const deps = makeDeps();

      detectHostReload(deps);

      const transport = deps.requireTransport();
      expect(vi.mocked(transport.connect)).toHaveBeenCalledWith(
        expect.objectContaining({ role: "host", code: "RELOADX", reclaimToken: "tok-DO" })
      );
    });

    it("with a record: a pre-set selfId is preserved (not re-minted)", async () => {
      const record: HostReentryRecord = {
        roomCode: "RELOAD2",
        hostToken: "tok-2",
        snapshot: {},
        sSeq: 7,
        savedAt: 1_700_000_000_001
      };
      vi.spyOn(persistence, "readReentryRecord").mockReturnValue(record);
      vi.spyOn(persistence, "armPersistence").mockReturnValue({
        flushNow: vi.fn(),
        dispose: vi.fn(),
        discard: vi.fn(),
        _update: vi.fn()
      });

      const state = createSessionState();
      state.selfId = "kept-host-id";
      const deps = makeDeps(state);

      detectHostReload(deps);

      expect(deps.state.selfId).toBe("kept-host-id");
      const transport = deps.requireTransport();
      expect(vi.mocked(transport.connect)).toHaveBeenCalledWith(
        expect.objectContaining({ selfId: "kept-host-id" })
      );
    });

    it("with a record: a rejected transport.connect is swallowed (no throw)", async () => {
      const record: HostReentryRecord = {
        roomCode: "RELOAD3",
        hostToken: "tok-3",
        snapshot: {},
        sSeq: 1,
        savedAt: 1_700_000_000_002
      };
      vi.spyOn(persistence, "readReentryRecord").mockReturnValue(record);
      vi.spyOn(persistence, "armPersistence").mockReturnValue({
        flushNow: vi.fn(),
        dispose: vi.fn(),
        discard: vi.fn(),
        _update: vi.fn()
      });

      const deps = makeDeps(createSessionState(), () => Promise.reject(new Error("net down")));

      // The .catch() on the connect promise must absorb the rejection.
      expect(() => detectHostReload(deps)).not.toThrow();
      // Let the rejected promise settle so no unhandled-rejection surfaces.
      await Promise.resolve();
      expect(deps.emit.hostReconnecting).toHaveBeenCalledWith({});
    });
  });
});
