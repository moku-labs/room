/**
 * @file Wire/peer-event handler FACTORIES (NOT Moku-`emit` hook handlers — `sessionPlugin` subscribes to
 * no Moku event; its inbound signals are the §2 wire + transport peer callbacks). Each factory closes over
 * THIS app's destructured `deps` (D14) and is a thin dispatcher delegating to `lifecycle/*` + `recovery/*`
 * (spec/15 §8 "no domain logic in handlers"). The ONLY `emit` calls here are the three owned `room:*`
 * events (via `deps.emit`).
 * @see README.md
 */

import type { Frame, PeerId, RosterEntry } from "../../contracts";
import type { SessionDeps } from "./types";

/**
 * A controller channel reached `connected` (§6): enforce the cap (`maxControllers`) — reject the 9th —
 * otherwise upsert the `RosterEntry`, broadcast the roster, and `emit("room:peer-joined", { peerId })`.
 *
 * @param deps - This app's destructured per-instance pieces.
 * @throws {Error} Always — skeleton stub.
 * @example
 * ```ts
 * transport.onPeerConnected(handlePeerConnected(deps));
 * ```
 */
export function handlePeerConnected(
  deps: SessionDeps
): (peerId: PeerId, entry: RosterEntry) => void {
  throw new Error("not implemented");
}

/**
 * A controller died (heartbeat, §2.4) or left: remove it from the roster, broadcast the new roster, and
 * `emit("room:peer-left", { peerId })`.
 *
 * @param deps - This app's destructured per-instance pieces.
 * @throws {Error} Always — skeleton stub.
 * @example
 * ```ts
 * transport.onPeerLost(handlePeerLost(deps));
 * ```
 */
export function handlePeerLost(deps: SessionDeps): (peerId: PeerId) => void {
  throw new Error("not implemented");
}

/**
 * (Controller side) the host channel dropped: enter `recovery.phase = "host-absent"`, start buffering
 * intents, and arm the `reconnectTimeoutMs` timer (§5.3/§5.4).
 *
 * @param deps - This app's destructured per-instance pieces.
 * @throws {Error} Always — skeleton stub.
 * @example
 * ```ts
 * transport.onHostChannelLost(handleHostChannelLost(deps));
 * ```
 */
export function handleHostChannelLost(deps: SessionDeps): () => void {
  throw new Error("not implemented");
}

/**
 * Dispatches inbound recovery `Frame` variants (§5.3): `RecoveryHelloFrame` (host verifies the token,
 * replies `RecoveryWelcomeFrame`, re-broadcasts a fresh snapshot via the `sync` seam),
 * `RecoveryWelcomeFrame` (controller verifies the stored token, sends `RecoveryFlushFrame`, moves to
 * `"reconciling"`), `RecoveryFlushFrame` (host applies buffered intents in `cSeq` order, dropping
 * `cSeq <= lastApplied[peerId]` — §4.3 idempotence). Non-recovery frames are ignored here.
 *
 * @param deps - This app's destructured per-instance pieces.
 * @throws {Error} Always — skeleton stub.
 * @example
 * ```ts
 * wire.on(handleRecoveryFrame(deps));
 * ```
 */
export function handleRecoveryFrame(deps: SessionDeps): (peerId: PeerId, frame: Frame) => void {
  throw new Error("not implemented");
}

/**
 * Rejects any controller<->controller channel attempt (§6, D11): the host is the only hub. Logs via
 * `ctx.log.warn` (no event — fullness/topology are not connectivity events).
 *
 * @param deps - This app's destructured per-instance pieces.
 * @throws {Error} Always — skeleton stub.
 * @example
 * ```ts
 * transport.onChannelAttempt(handleStarTopologyViolation(deps));
 * ```
 */
export function handleStarTopologyViolation(deps: SessionDeps): (from: PeerId, to: PeerId) => void {
  throw new Error("not implemented");
}
