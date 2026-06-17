/**
 * @file `createSessionState` — the pure `createState` factory for `sessionPlugin`. Receives the minimal
 * `{ global, config }` context only (spec/15 state.ts contract): no `emit`, no `require`, no DOM, no
 * `crypto`. Returns the zeroed, plain-JSON state; all DOM/storage/`crypto` access happens later in
 * `api`/`handlers`/`onInit`.
 * @see README.md
 */

import type { SessionState } from "./types";

/**
 * Builds the zeroed initial `SessionState` for one app instance. Pure: it reads nothing from the DOM,
 * `crypto`, or the network and produces only plain-JSON fields (the `recovery.timer`/`persistHandle`
 * runtime handles start `null` and are armed later in `api`/`onInit`).
 *
 * @returns The zeroed `SessionState` with role `"none"`, empty roster, recovery phase `"stable"`.
 * @example
 * ```ts
 * createPlugin("session", { createState: createSessionState, ... });
 * ```
 */
export function createSessionState(): SessionState {
  return {
    role: "none",
    selfId: "",
    roomCode: "",
    hostToken: "",
    roster: {},
    sSeqAtSnapshot: 0,
    recovery: {
      phase: "stable",
      buffer: [],
      reconnectDeadline: 0,
      timer: null,
      persistHandle: null
    }
  };
}
