/**
 * @file This tab's `selfId` per room (§6.1). It lives in `sessionStorage`, so a reload in the same tab is the same
 * player and a second tab is another one. `leave()` and a `full` result forget it. A device with no usable
 * `sessionStorage` keeps the id in `state` only, for as long as the app lives.
 * @see ../README.md
 */

import { mintHostToken } from "../recovery/hosttoken";
import type { PeerId, SessionDeps } from "../types";

/**
 * Builds the room-code-scoped `sessionStorage` key of this tab's id.
 *
 * @param deps - This app's destructured per-instance pieces.
 * @param code - The room code.
 * @returns The fully-qualified key.
 * @example
 * ```ts
 * selfIdKey(deps, "G7K2QF"); // "moku.room.self.G7K2QF"
 * ```
 */
function selfIdKey(deps: SessionDeps, code: string): string {
  return `${deps.config.storageKeyPrefix}.self.${code}`;
}

/**
 * Returns this tab's id for room `code`: the saved one, or a new one it saves. One `catch` covers every way
 * storage can fail: absent in this runtime, blocked in this frame, over quota. There the id stays what `state`
 * holds, and only an empty `state` mints.
 *
 * @param deps - This app's destructured per-instance pieces.
 * @param code - The room code being joined.
 * @returns The id to join with.
 * @example
 * ```ts
 * deps.state.selfId = loadOrMintSelfId(deps, "G7K2QF");
 * ```
 */
export function loadOrMintSelfId(deps: SessionDeps, code: string): PeerId {
  const key = selfIdKey(deps, code);
  try {
    const saved = sessionStorage.getItem(key);
    if (saved) return saved;
    const minted = mintHostToken();
    sessionStorage.setItem(key, minted);
    return minted;
  } catch {
    return deps.state.selfId || mintHostToken();
  }
}

/**
 * Removes this tab's id for room `code`, so the next join there is a new player. A no-op with no usable storage.
 *
 * @param deps - This app's destructured per-instance pieces.
 * @param code - The room code.
 * @example
 * ```ts
 * forgetSelfId(deps, deps.state.roomCode); // in leave()
 * ```
 */
export function forgetSelfId(deps: SessionDeps, code: string): void {
  try {
    sessionStorage.removeItem(selfIdKey(deps, code));
  } catch {
    // No usable storage, so nothing was saved.
  }
}
