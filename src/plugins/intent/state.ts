/**
 * Per-app state factory for the intent plugin.
 *
 * Returns a fresh {@link IntentState} per `createApp` (D14 — NO module-level singleton): empty
 * `registry`/`lastApplied` `Map`s, `nextCSeq` at `0`, `buffering` off, empty `buffer`. The host
 * receive path ({@link ./receive}) and the API surface ({@link ./api}) both read/write this SAME
 * `ctx.state`, which is what keeps multiple composed app instances isolated.
 *
 * @file
 * @see README.md
 */
import type { IntentState } from "./types";

/**
 * Builds the initial per-app {@link IntentState}. Config-light — neither field of {@link IntentConfig}
 * is read here (the buffer cap/age are applied at enqueue/drain time in {@link ./api}, not at
 * construction). Typed return (no inline `as`) so `createIntentState` carries no type assertion (R6).
 * Per-`createApp` via `ctx.state` (D14) — never a module-level singleton.
 *
 * @throws {Error} Always, until implemented (skeleton stub).
 * @example
 * ```ts
 * const state = createIntentState();
 * // { registry: Map(0), lastApplied: Map(0), nextCSeq: 0, buffering: false, buffer: [] }
 * ```
 */
export function createIntentState(): IntentState {
  throw new Error("not implemented");
}
