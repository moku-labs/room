/**
 * @file Roster mutations (§6.1): upsert/remove a `RosterEntry`, enforce the `maxControllers` cap (the 9th
 * controller is rejected), enforce STAR TOPOLOGY (reject any controller<->controller channel — the host is
 * the sole hub, D11), and read a sorted defensive copy. Pure functions over `SessionState.roster`; the
 * `room:*` emissions live in `handlers.ts`, not here.
 * @see ../README.md
 */

import type { PeerId, RosterEntry } from "../../transport/protocol";
import type { Role, SessionState } from "../types";

/**
 * Upserts a controller into the roster, enforcing the `maxControllers` cap (§6.1). Returns whether the
 * entry was admitted: `false` means the room is full and the channel must be rejected (the 9th join).
 *
 * @param state - This app's mutable session state.
 * @param entry - The roster entry to admit or refresh.
 * @param maxControllers - The configured cap (`config.maxControllers`).
 * @returns `true` if the entry was admitted/updated, `false` if the room is full.
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
  // Allow updating an existing entry even at cap.
  if (!(entry.id in state.roster) && Object.keys(state.roster).length >= maxControllers) {
    return false;
  }
  state.roster[entry.id] = entry;
  return true;
}

/**
 * Removes a controller from the roster by id (on leave or heartbeat-dead, §2.4). Idempotent — a no-op
 * when the peer is absent.
 *
 * @param state - This app's mutable session state.
 * @param peerId - The controller to remove.
 * @returns `true` if the entry was present and removed, `false` if it was already absent.
 * @example
 * ```ts
 * if (removeRosterEntry(state, peerId)) emit.peerLeft({ peerId });
 * ```
 */
export function removeRosterEntry(state: SessionState, peerId: PeerId): boolean {
  if (!(peerId in state.roster)) return false;

  delete state.roster[peerId];
  return true;
}

/**
 * Returns a sorted defensive copy of the roster (by `joinedAt` ascending), so callers cannot mutate
 * internal state (§6.1).
 *
 * @param state - This app's session state.
 * @returns A frozen, sorted defensive copy of the roster entries.
 * @example
 * ```ts
 * const seats = readRoster(state);
 * ```
 */
export function readRoster(state: SessionState): readonly RosterEntry[] {
  return Object.values(state.roster).toSorted((a, b) => a.joinedAt - b.joinedAt);
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
 * @returns `true` if the channel violates star topology and should be rejected.
 * @example
 * ```ts
 * if (isStarViolation(from, to, state.selfId, state.role)) log.warn("rejected p2p channel");
 * ```
 */
export function isStarViolation(from: PeerId, to: PeerId, selfId: PeerId, role: Role): boolean {
  if (role !== "host") {
    // On a controller, any channel not involving us as host is a violation.
    return from !== selfId && to !== selfId;
  }
  // On the host, we are the hub — from/to must involve selfId.
  return from !== selfId && to !== selfId;
}
