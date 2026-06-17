/**
 * @file Host-reload re-entry wiring (§5.2, D14). `registerTransportBindings` registers the transport
 * peer-connection callbacks + the single `Wire.on(handler)` inbound-frame router against THIS app's
 * destructured `deps` (never a module-level cached instance). `detectHostReload` reads back the persisted
 * `HostReentryRecord` during `onInit`; on a hit it restores host state, instructs transport to REJOIN THE
 * SAME room code (the external public backbone survives the tab reload), and emits `room:host-reconnecting`.
 * @see ../README.md
 */

import type { JoinResult, SessionDeps } from "../types";

/**
 * `onInit` WIRING (D14): resolves the hard dependency (`deps.requireTransport()`), registers the transport
 * peer-connection callbacks (connected/lost) and the single `Wire.on` inbound-frame router — all against
 * THIS app's `deps.state`/`deps.requireTransport`/`deps.emit`, so the `handlers.ts` factories close over the
 * correct per-app state. Opens NO connections (those are lazy, on `createRoom`/`joinRoom`).
 *
 * @param deps - This app's destructured per-instance pieces.
 * @throws {Error} Always — skeleton stub.
 * @example
 * ```ts
 * onInit: (ctx) => { registerTransportBindings(deps); detectHostReload(deps); }
 * ```
 */
export function registerTransportBindings(deps: SessionDeps): void {
  throw new Error("not implemented");
}

/**
 * `onInit` host-reload detection (§5.2). Reads back the `HostReentryRecord`; on a fresh hit it sets
 * `role:"host"`, restores `roomCode`/`hostToken`/`sSeqAtSnapshot`, instructs transport to REJOIN the same
 * room code, and emits `room:host-reconnecting {}`. No-op when there is no record. Note: on the reload path
 * this event fires BEFORE consumer hooks are wired — consumers must POLL `recoveryPhase()` (see README).
 *
 * @param deps - This app's destructured per-instance pieces.
 * @throws {Error} Always — skeleton stub.
 * @example
 * ```ts
 * detectHostReload(deps);
 * ```
 */
export function detectHostReload(deps: SessionDeps): void {
  throw new Error("not implemented");
}

/**
 * Re-runs the join handshake against the stored `roomCode`, re-using the phone-persisted `reconnectToken`
 * so the controller re-binds to the same roster slot (the iOS "rescan QR" / `rejoin()` path, §5.4).
 *
 * @param deps - This app's destructured per-instance pieces.
 * @throws {Error} Always — skeleton stub.
 * @example
 * ```ts
 * const res = await rejoinSameRoom(deps);
 * ```
 */
export function rejoinSameRoom(deps: SessionDeps): Promise<JoinResult> {
  throw new Error("not implemented");
}
