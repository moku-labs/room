/**
 * @file Host-reload re-entry wiring (§5.2, D14). `registerTransportBindings` registers the transport
 * peer-connection callbacks + the single `Wire.on(handler)` inbound-frame router against THIS app's
 * destructured `deps` (never a module-level cached instance). `detectHostReload` reads back the persisted
 * `HostReentryRecord` during `onInit`; on a hit it restores host state, instructs transport to REJOIN THE
 * SAME room code (the external public backbone survives the tab reload), and emits `room:host-reconnecting`.
 * @see ../README.md
 */

import {
  handleHostChannelLost,
  handlePeerConnected,
  handlePeerLost,
  handleRecoveryFrame
} from "../handlers";
import type { JoinResult, SessionDeps } from "../types";
import { mintHostToken } from "./hosttoken";
import { armPersistence, readReentryRecord } from "./persistence";

/**
 * `onInit` WIRING (D14): resolves the hard dependency (`deps.requireTransport()`), registers the transport
 * peer-connection callbacks (connected/lost) and the single `Wire.on` inbound-frame router — all against
 * THIS app's `deps.state`/`deps.requireTransport`/`deps.emit`, so the `handlers.ts` factories close over the
 * correct per-app state. Opens NO connections (those are lazy, on `createRoom`/`joinRoom`).
 *
 * D18 wiring — role-discriminated:
 * - `onPeerConnected`: host → upsert roster + `room:peer-joined`; controller → record host id + resolve
 *   pending joinRoom promise.
 * - `onPeerLost`: host → remove roster + `room:peer-left`; controller + lost peer IS host → enter
 *   `host-absent` + arm reconnect timeout.
 * - `wire().on(handleRecoveryFrame(deps))` — dispatches inbound recovery frames.
 *
 * @param deps - This app's destructured per-instance pieces.
 * @example
 * ```ts
 * onInit: (ctx) => { registerTransportBindings(deps); detectHostReload(deps); }
 * ```
 */
export function registerTransportBindings(deps: SessionDeps): void {
  const transport = deps.requireTransport();

  transport.onPeerConnected(peerId => {
    if (deps.state.role === "host") {
      // Host side: a controller connected — build a basic RosterEntry and handle it.
      const entry = {
        id: peerId,
        reconnectToken: "",
        joinedAt: Date.now()
      };
      handlePeerConnected(deps)(peerId, entry);
    } else {
      // Controller side: the host is the single star hub. Accept a connecting peer as the host ONLY
      // when we are actively (re)connecting to one — a pending joinRoom, OR a non-"stable" recovery
      // phase (host re-entry after absence). Once stable with a known host, a later connection is NOT
      // the host (e.g. a non-star / meshing signaling adapter surfacing another controller) and must
      // not clobber `_hostId` (finding #1). The pending resolver/host id live on the runtime extension.
      const rt = deps.state as unknown as SessionStateWithRuntime;
      const expectingHost =
        rt._pendingJoinResolve !== null || deps.state.recovery.phase !== "stable";
      if (rt._hostId !== null && !expectingHost) return;

      deps.state.selfId = deps.state.selfId || peerId; // keep our own id if already set
      // Resolve any pending joinRoom promise by updating recovery phase.
      deps.state.recovery.phase = "stable";
      const resolver = rt._pendingJoinResolve;
      if (resolver) {
        rt._pendingJoinResolve = null;
        rt._hostId = peerId;
        resolver({ ok: true, selfId: deps.state.selfId });
      } else {
        rt._hostId = peerId;
      }
    }
  });

  transport.onPeerLost(peerId => {
    if (deps.state.role === "host") {
      // Host side: a controller died — remove from roster.
      handlePeerLost(deps)(peerId);
    } else {
      // Controller side: check if the lost peer is the host.
      const rt = deps.state as unknown as SessionStateWithRuntime;
      if (rt._hostId && peerId === rt._hostId) {
        handleHostChannelLost(deps)();
      }
    }
  });

  // Register the single inbound-frame router for recovery frames.
  transport.wire().on(handleRecoveryFrame(deps));
}

/**
 * `onInit` host-reload detection (§5.2). Reads back the `HostReentryRecord`; on a fresh hit it sets
 * `role:"host"`, restores `roomCode`/`hostToken`/`sSeqAtSnapshot`, instructs transport to REJOIN the same
 * room code, and emits `room:host-reconnecting {}`. No-op when there is no record. Note: on the reload path
 * this event fires BEFORE consumer hooks are wired — consumers must POLL `recoveryPhase()` (see README).
 *
 * @param deps - This app's destructured per-instance pieces.
 * @example
 * ```ts
 * detectHostReload(deps);
 * ```
 */
export function detectHostReload(deps: SessionDeps): void {
  const record = readReentryRecord(deps);
  if (!record) return;

  // Restore host identity from the persisted record.
  deps.state.role = "host";
  deps.state.roomCode = record.roomCode;
  deps.state.hostToken = record.hostToken;
  deps.state.sSeqAtSnapshot = record.sSeq;
  // Mint a new selfId for the host (the old one is no longer valid for this session).
  deps.state.selfId = deps.state.selfId || mintHostToken();

  // Store the record for re-broadcasting on controller reconnect.
  const rt = deps.state as unknown as SessionStateWithRuntime;
  rt._reentryRecord = record;

  // Arm persistence driver so we keep snapshotting.
  deps.state.recovery.persistHandle = armPersistence(deps);

  // Emit the host-reconnecting signal.
  deps.emit.hostReconnecting({});

  // Instruct transport to rejoin the same room code (async, but we don't await in onInit). Replay the
  // persisted reclaim token (serverSignaling only) so the warm DO re-binds this host and its controllers
  // re-handshake, instead of opening a fresh, empty room (§1.3/§5.1, D25). exact-optional: omit the key
  // when there is no token (publicRendezvous/inMemory deployments).
  const transport = deps.requireTransport();
  transport
    .connect({
      role: "host",
      selfId: deps.state.selfId,
      code: record.roomCode,
      ...(record.reclaimToken === undefined ? {} : { reclaimToken: record.reclaimToken })
    })
    .catch(() => {
      // Best-effort: failure is surfaced via room:network-warning from transport.
    });
}

/**
 * Re-runs the join handshake against the stored `roomCode`, re-using the phone-persisted `reconnectToken`
 * so the controller re-binds to the same roster slot (the iOS "rescan QR" / `rejoin()` path, §5.4).
 *
 * @param deps - This app's destructured per-instance pieces.
 * @returns A promise resolving to the `JoinResult`.
 * @throws {Error} If there is no prior room to rejoin (no stored `roomCode`).
 * @example
 * ```ts
 * const res = await rejoinSameRoom(deps);
 * ```
 */
export function rejoinSameRoom(deps: SessionDeps): Promise<JoinResult> {
  if (!deps.state.roomCode) {
    throw new Error(
      "[room] Cannot rejoin: no active roomCode stored.\n  Call joinRoom(code) first."
    );
  }
  return doJoinRoom(deps, deps.state.roomCode);
}

/**
 * Runtime-only fields on SessionState (never serialized). These escape the typed surface because they are
 * timer/promise handles — exactly like recovery.timer/persistHandle but stored at the state root level
 * for convenience. They are accessed only within the session plugin and never cross the wire.
 */
export type SessionStateWithRuntime = {
  _pendingJoinResolve: ((result: JoinResult) => void) | null;
  _pendingJoinReject: ((reason: unknown) => void) | null;
  _hostId: string | null;
  _joinTimeout: ReturnType<typeof setTimeout> | null;
  _reentryRecord: import("../types").HostReentryRecord | null;
};

/**
 * Internal join-room implementation used by both `joinRoom` and `rejoinSameRoom`.
 * Calls `transport.connect` with the controller role and waits for `onPeerConnected` to
 * fire (signalling the host channel is open), with a timeout fallback.
 *
 * @param deps - This app's destructured per-instance pieces.
 * @param code - The room code to join.
 * @returns A promise resolving to the `JoinResult`.
 * @example
 * ```ts
 * const result = await doJoinRoom(deps, "G7K2QF");
 * ```
 */
export function doJoinRoom(deps: SessionDeps, code: string): Promise<JoinResult> {
  return new Promise<JoinResult>(resolve => {
    const stateRuntime = deps.state as unknown as SessionStateWithRuntime;

    // Clear any previously pending join.
    if (stateRuntime._joinTimeout) {
      clearTimeout(stateRuntime._joinTimeout);
      stateRuntime._joinTimeout = null;
    }

    // Store the resolver so registerTransportBindings can call it on peer-connected.
    stateRuntime._pendingJoinResolve = resolve;

    // Set a timeout — if no host connects within reconnectTimeoutMs, resolve unreachable.
    stateRuntime._joinTimeout = setTimeout(() => {
      stateRuntime._joinTimeout = null;
      if (stateRuntime._pendingJoinResolve === resolve) {
        stateRuntime._pendingJoinResolve = null;
        resolve({ ok: false, reason: "unreachable" });
      }
    }, deps.config.reconnectTimeoutMs);

    // Update state.
    deps.state.roomCode = code;
    deps.state.role = "controller";

    const transport = deps.requireTransport();
    transport
      .connect({
        role: "controller",
        selfId: deps.state.selfId,
        code
      })
      .catch(() => {
        if (stateRuntime._pendingJoinResolve === resolve) {
          stateRuntime._pendingJoinResolve = null;
          if (stateRuntime._joinTimeout) {
            clearTimeout(stateRuntime._joinTimeout);
            stateRuntime._joinTimeout = null;
          }
          resolve({ ok: false, reason: "not-found" });
        }
      });
  });
}
