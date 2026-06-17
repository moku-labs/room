/**
 * @file Per-app state factory for `syncPlugin` (empty snapshot, no engine, no timer).
 * @see README.md
 *
 * `createSyncState` returns the documented `State` defaults: an empty authoritative/replica `Snapshot`,
 * an empty dirty set, `sSeq: 0`, `ready: false`, `stale: false`, `broadcasting: false`, and the two
 * NON-serialized runtime cells (`throttleHandle`, `engine`) both `null` at rest. Every serialized field
 * is plain-JSON (spec/11 section 1.7); the runtime cells are assigned later (`engine` in `api`,
 * `throttleHandle` in `startBroadcast`).
 */
import type { State } from "./types";

/**
 * Builds the initial mutable `syncPlugin` state for ONE app instance. Pure — no side effects, no timers,
 * no engine. The `engine` cell is filled in by `api` (the ONE per-app engine) and `throttleHandle` by
 * `startBroadcast`; both stay `null` here so the at-rest state is plain-JSON-serializable. Per-`createApp`
 * via `ctx.state` (D14) — never a module-level singleton.
 *
 * @throws {Error} Always — skeleton stub.
 * @example
 * ```ts
 * const state = createSyncState();
 * // { snapshot: {}, dirty: {}, sSeq: 0, ready: false, stale: false,
 * //   broadcasting: false, throttleHandle: null, engine: null }
 * ```
 */
export function createSyncState(): State {
  throw new Error("not implemented");
}
