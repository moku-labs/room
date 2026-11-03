/**
 * @file The one place a controller's pending join ends (§6.2): clears the timeout and the resolver, resets
 * the room on a failure, and resolves the `JoinResult`. Every outcome goes through it: the host's `roster` and
 * `room-full` frames, a rejected `transport.connect`, and the unreachable timeout.
 * @see ../README.md
 */

import type { JoinResult, SessionDeps, SessionState } from "../types";
import { forgetSelfId } from "./self-id";

/**
 * Runs the `onRoomEnded` callbacks: this device's room is over.
 *
 * @param state - This app's session state, which holds the callbacks.
 * @example
 * ```ts
 * notifyRoomEnded(deps.state); // the last line of leave()
 * ```
 */
export function notifyRoomEnded(state: SessionState): void {
  for (const callback of state._roomEndedCallbacks ?? []) callback();
}

/**
 * Settles the pending join with `result`. A no-op when none is pending, so a stray frame changes nothing. A
 * failed first join leaves no room behind: `role` `"none"`, `roomCode` `""`, no host id, no recovery running
 * (a refused device whose `room-full` frame was lost sees its host die on the heartbeat before the timeout),
 * transport closed. The promise resolves only after the close finished, so a retry made on the result never
 * races the teardown; `close()` keeps the wiring, so that retry is heard by the same consumers. That is also the
 * end of the room, so the `onRoomEnded` callbacks run. A failed re-entry (`rejoin`) keeps the room, and the
 * transport stays open for the host to come back on. A `full` result, on either path, forgets this tab's saved id.
 *
 * @param deps - This app's destructured per-instance pieces.
 * @param result - The join's outcome.
 * @example
 * ```ts
 * settleJoin(deps, { ok: false, reason: "full" });
 * ```
 */
export function settleJoin(deps: SessionDeps, result: JoinResult): void {
  const { state } = deps;
  const resolve = state._pendingJoinResolve;
  if (!resolve) return;

  state._pendingJoinResolve = null;
  if (state._joinTimeout) {
    clearTimeout(state._joinTimeout);
    state._joinTimeout = null;
  }

  // Read before the reset below clears the code. The check above keeps a stray frame from forgetting a seated id.
  if (!result.ok && result.reason === "full") forgetSelfId(deps, state.roomCode);

  if (result.ok || state._pendingJoinKeepsRoom) {
    resolve(result);
    return;
  }

  state.role = "none";
  state.roomCode = "";
  state._hostId = null;
  if (state.recovery.timer !== null) {
    clearTimeout(state.recovery.timer);
    state.recovery.timer = null;
  }
  state.recovery.phase = "stable";
  state.recovery.reconnectDeadline = 0;
  deps
    .requireTransport()
    .close()
    .catch(() => {
      // A failed teardown is best-effort: the caller still gets the join's result.
    })
    .finally(() => {
      resolve(result);
      // Same tick: the caller's continuation runs after this, so a retry made on the result finds it done.
      notifyRoomEnded(state);
    });
}
