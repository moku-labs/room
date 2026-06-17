/**
 * @file Host-snapshot persistence driver (§5.1): a debounced IndexedDB write (~`snapshotDebounceMs`)
 * during normal play PLUS a SYNCHRONOUS `localStorage` write on `visibilitychange` (the only reliable
 * last-moment hook on iOS/Android-TV — `beforeunload`/`pagehide` are unreliable there). Produces a
 * `PersistHandle`. DOM/storage access is DOM-guarded (`typeof window`/`indexedDB`) so the
 * `inMemory`/headless path degrades gracefully. `teardownSession` is the `onStop` entry point (takes
 * `SessionState`, NOT a singleton).
 * @see ../README.md
 */

import type { HostReentryRecord, SessionDeps, SessionState } from "../types";
import type { PersistHandle } from "./types";

/**
 * Arms the persistence driver for the HOST: starts the debounced IndexedDB writer and registers the
 * synchronous `localStorage`-on-`visibilitychange` listener (§5.1). The returned `PersistHandle` is stored
 * into `deps.state.recovery.persistHandle`; the driver retains the latest record internally so `flushNow()`
 * needs no `state`. DOM/storage access is DOM-guarded (`typeof window`/`indexedDB`).
 *
 * @param deps - This app's destructured per-instance pieces (`config` and `state`).
 * @throws {Error} Always — skeleton stub.
 * @example
 * ```ts
 * deps.state.recovery.persistHandle = armPersistence(deps);
 * ```
 */
export function armPersistence(deps: SessionDeps): PersistHandle {
  throw new Error("not implemented");
}

/**
 * Records the latest authoritative snapshot for persistence (§5.1). Updates the driver's retained
 * `HostReentryRecord`, schedules the debounced IndexedDB write, and stamps `sSeqAtSnapshot`. Opaque to the
 * payload — `session` never inspects the `Snapshot`.
 *
 * @param deps - This app's destructured per-instance pieces.
 * @param record - The full re-entry record (room code + host token + snapshot + sSeq + savedAt).
 * @throws {Error} Always — skeleton stub.
 * @example
 * ```ts
 * recordSnapshot(deps, { roomCode, hostToken, snapshot, sSeq, savedAt: Date.now() });
 * ```
 */
export function recordSnapshot(deps: SessionDeps, record: HostReentryRecord): void {
  throw new Error("not implemented");
}

/**
 * Reads back the persisted `HostReentryRecord` for this origin (localStorage first, then IndexedDB) on
 * reload (§5.2). Returns `null` when there is no record or it is stale. DOM/storage access is DOM-guarded
 * (`typeof window`/`indexedDB`).
 *
 * @param deps - This app's destructured per-instance pieces.
 * @throws {Error} Always — skeleton stub.
 * @example
 * ```ts
 * const rec = readReentryRecord(deps);
 * ```
 */
export function readReentryRecord(deps: SessionDeps): HostReentryRecord | null {
  throw new Error("not implemented");
}

/**
 * `onStop` teardown for the recovery sub-domain (D14). Does the final SYNCHRONOUS snapshot persist FIRST
 * (`persistHandle.flushNow()` — the same localStorage path as `visibilitychange`), THEN clears timers and
 * removes the `visibilitychange` listener (`persistHandle.dispose()`), and nulls `recovery.timer`. Takes
 * the per-app `SessionState` (recovered from the `teardownRegistry` WeakMap) — NEVER a module-level
 * singleton — so it needs no `state`/`require`/`emit` (the `{ global }`-only teardown context).
 *
 * @param state - This app's `SessionState`, looked up via `teardownRegistry.get(ctx.global)`.
 * @throws {Error} Always — skeleton stub.
 * @example
 * ```ts
 * const s = teardownRegistry.get(ctx.global);
 * if (s) teardownSession(s);
 * ```
 */
export function teardownSession(state: SessionState): void {
  throw new Error("not implemented");
}
