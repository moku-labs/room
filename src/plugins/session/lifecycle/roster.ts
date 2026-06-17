/**
 * @file Roster mutations (§6.1): upsert/remove a `RosterEntry`, enforce the `maxControllers` cap (the 9th
 * controller is rejected), enforce STAR TOPOLOGY (reject any controller<->controller channel — the host is
 * the sole hub, D11), and read a sorted defensive copy. Pure functions over `SessionState.roster`; the
 * `room:*` emissions live in `handlers.ts`, not here.
 * @see ../README.md
 */

import type { PeerId, RosterEntry } from "../../../contracts";
import type { Role, SessionState } from "../types";

/**
 * Upserts a controller into the roster, enforcing the `maxControllers` cap (§6.1). Returns whether the
 * entry was admitted: `false` means the room is full and the channel must be rejected (the 9th join).
 *
 * @param state - This app's mutable session state.
 * @param entry - The roster entry to admit or refresh.
 * @param maxControllers - The configured cap (`config.maxControllers`).
 * @throws {Error} Always — skeleton stub.
 * @example
 * ```ts
 * if (!upsertRosterEntry(state, entry, config.maxControllers)) rejectChannel(peerId);
 * ```
 */
export function upsertRosterEntry(
  state: SessionState,
  entry: RosterEntry,
  maxControllers: number
): boolean {
  throw new Error("not implemented");
}

/**
 * Removes a controller from the roster by id (on leave or heartbeat-dead, §2.4). Idempotent — a no-op
 * when the peer is absent.
 *
 * @param state - This app's mutable session state.
 * @param peerId - The controller to remove.
 * @throws {Error} Always — skeleton stub.
 * @example
 * ```ts
 * if (removeRosterEntry(state, peerId)) emit.peerLeft({ peerId });
 * ```
 */
export function removeRosterEntry(state: SessionState, peerId: PeerId): boolean {
  throw new Error("not implemented");
}

/**
 * Returns a sorted defensive copy of the roster (by `joinedAt` ascending), so callers cannot mutate
 * internal state (§6.1).
 *
 * @param state - This app's session state.
 * @throws {Error} Always — skeleton stub.
 * @example
 * ```ts
 * const seats = readRoster(state);
 * ```
 */
export function readRoster(state: SessionState): readonly RosterEntry[] {
  throw new Error("not implemented");
}

/**
 * Star-topology guard (§6, D11): returns `true` if a channel attempt between `from` and `to` violates the
 * star (i.e. neither endpoint is the host). The host is the only hub — controller<->controller channels
 * are always rejected.
 *
 * @param from - The initiating peer id.
 * @param to - The target peer id.
 * @param selfId - This device's id (the host, on the stage).
 * @param role - This device's role.
 * @throws {Error} Always — skeleton stub.
 * @example
 * ```ts
 * if (isStarViolation(from, to, state.selfId, state.role)) log.warn("rejected p2p channel");
 * ```
 */
export function isStarViolation(from: PeerId, to: PeerId, selfId: PeerId, role: Role): boolean {
  throw new Error("not implemented");
}
