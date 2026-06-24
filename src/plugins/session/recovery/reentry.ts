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
import type { JoinResult, SessionDeps, SessionState } from "../types";
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
    // Host branch: a controller connected.
    if (deps.state.role === "host") {
      // Build a basic RosterEntry and handle it.
      const entry = {
        id: peerId,
        reconnectToken: "",
        joinedAt: Date.now()
      };
      handlePeerConnected(deps)(peerId, entry);
    } else {
      // Controller branch: the host is the single star hub. Accept a connecting peer as the host ONLY
      // when we are actively (re)connecting to one — a pending joinRoom, OR a non-"stable" recovery
      // phase (host re-entry after absence). Once stable with a known host, a later connection is NOT
      // the host (e.g. a non-star / meshing signaling adapter surfacing another controller) and must
      // not clobber `_hostId` (finding #1). The pending resolver/host id live on the runtime extension.
      const rt = deps.state;
      const expectingHost =
        rt._pendingJoinResolve !== null || deps.state.recovery.phase !== "stable";
      if (rt._hostId !== null && !expectingHost) return;

      // Adopt the connecting peer as the host and mark recovery stable.
      deps.state.selfId = deps.state.selfId || peerId; // keep our own id if already set
      deps.state.recovery.phase = "stable";

      // Settle any pending joinRoom resolver, recording this peer as the host id either way.
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
    // Host branch: a controller died — remove from roster.
    if (deps.state.role === "host") {
      handlePeerLost(deps)(peerId);
    } else {
      // Controller branch: only react when the lost peer is our current host.
      const rt = deps.state;
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
  const rt = deps.state;
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
 * Legacy/test alias of {@link SessionState}, which now declares the runtime-only handles
 * (`_pendingJoinResolve` / `_pendingJoinReject` / `_hostId` / `_joinTimeout` / `_reentryRecord`) directly
 * as optional, never-serialized fields — peers of `recovery.timer`/`persistHandle`. Production code reads
 * them straight off `SessionState` (no cast); this alias is retained only so existing tests that import
 * `SessionStateWithRuntime` keep compiling.
 */
export type SessionStateWithRuntime = SessionState;

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
    const stateRuntime = deps.state;

    // Clear any prior in-flight join timeout.
    if (stateRuntime._joinTimeout) {
      clearTimeout(stateRuntime._joinTimeout);
      stateRuntime._joinTimeout = null;
    }

    // Park the resolver so onPeerConnected can settle it.
    stateRuntime._pendingJoinResolve = resolve;

    // Arm the unreachable-host timeout.
    stateRuntime._joinTimeout = setTimeout(() => {
      stateRuntime._joinTimeout = null;
      if (stateRuntime._pendingJoinResolve === resolve) {
        stateRuntime._pendingJoinResolve = null;
        resolve({ ok: false, reason: "unreachable" });
      }
    }, deps.config.reconnectTimeoutMs);

    // Update state and initiate the transport connection.
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
