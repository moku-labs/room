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
import type { SessionStateWithRuntime } from "./reentry";
import type { PersistHandle } from "./types";

/** IndexedDB database name for the host re-entry record. */
const IDB_DB = "moku-room-reentry";
/** IndexedDB object-store name for the host re-entry record. */
const IDB_STORE = "records";

/**
 * Builds the room-code-scoped localStorage key for the synchronous host-reload record, so multiple
 * rooms on one device never collide (§6.1).
 *
 * @param storageKeyPrefix - The configured key prefix (`config.storageKeyPrefix`).
 * @param roomCode - The active 6-char room code (§6.2).
 * @returns The fully-qualified localStorage key.
 * @example
 * ```ts
 * localStorageKey("moku.room", "G7K2QF"); // "moku.room.reentry.G7K2QF"
 * ```
 */
function localStorageKey(storageKeyPrefix: string, roomCode: string): string {
  return `${storageKeyPrefix}.reentry.${roomCode}`;
}

/**
 * Writes a value to `localStorage` behind a DOM guard so the headless/Bun path no-ops cleanly.
 * Swallows quota/disabled errors — persistence is best-effort (§5.1).
 *
 * @param key - The localStorage key.
 * @param value - The JSON string to store.
 * @example
 * ```ts
 * tryLocalStorageSet("moku.room.reentry.G7K2QF", JSON.stringify(record));
 * ```
 */
function tryLocalStorageSet(key: string, value: string): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(key, value);
  } catch {
    // Quota exceeded or storage disabled — degrade gracefully.
  }
}

/**
 * Reads a value from `localStorage` behind a DOM guard.
 *
 * @param key - The localStorage key.
 * @returns The stored string, or `null` when unavailable.
 * @example
 * ```ts
 * const raw = tryLocalStorageGet("moku.room.reentry.G7K2QF");
 * ```
 */
function tryLocalStorageGet(key: string): string | null {
  if (typeof localStorage === "undefined") return null;
  try {
    return localStorage.getItem(key);
  } catch {
    // Storage disabled — degrade.
    return null;
  }
}

/**
 * Opens (and upgrades, if needed) the IndexedDB store for the host re-entry record. Resolves to `null`
 * in headless environments where `indexedDB` is absent so the durable path no-ops cleanly.
 *
 * @returns A promise resolving to the open `IDBDatabase`, or `null` when IndexedDB is unavailable.
 * @example
 * ```ts
 * const db = await openIdb();
 * if (db) db.transaction(IDB_STORE, "readwrite");
 * ```
 */
async function openIdb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return null;
  return new Promise<IDBDatabase | null>((resolve, reject) => {
    const request = indexedDB.open(IDB_DB, 1);
    request.addEventListener("upgradeneeded", () => {
      if (!request.result.objectStoreNames.contains(IDB_STORE)) {
        request.result.createObjectStore(IDB_STORE);
      }
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
}

/**
 * Persists the host re-entry record to IndexedDB. A no-op in headless environments (no `indexedDB`).
 *
 * @param record - The `HostReentryRecord` to persist.
 * @param key - The room-code-scoped storage key.
 * @returns A promise that resolves once the write transaction completes.
 * @example
 * ```ts
 * await writeToIdb(record, "moku.room.reentry.G7K2QF");
 * ```
 */
async function writeToIdb(record: HostReentryRecord, key: string): Promise<void> {
  const db = await openIdb();
  if (!db) return;
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(record, key);
    tx.addEventListener("complete", () => resolve());
    tx.addEventListener("error", () => reject(tx.error));
  });
}

/**
 * Internal extension of `PersistHandle` that adds the record updater used by {@link recordSnapshot}.
 * `_update` is a package-internal detail — NOT part of the public `PersistHandle` surface.
 */
type PersistHandleInternal = PersistHandle & {
  /**
   * Updates the retained latest record and optionally schedules the debounced IndexedDB write.
   *
   * @param record - The new latest `HostReentryRecord`.
   * @param scheduleIdb - Whether to (re)schedule the debounced durable write.
   * @example
   * ```ts
   * (handle as PersistHandleInternal)._update(record, true);
   * ```
   */
  _update(record: HostReentryRecord, scheduleIdb: boolean): void;
};

/**
 * Arms the persistence driver for the HOST: holds the latest record, schedules debounced IndexedDB
 * writes, and registers the synchronous `localStorage`-on-`visibilitychange` listener (§5.1). The
 * returned `PersistHandle` is stored into `deps.state.recovery.persistHandle`; the driver retains the
 * latest record internally so `flushNow()` needs no `state`. DOM/storage access is DOM-guarded.
 *
 * @param deps - This app's destructured per-instance pieces (`config` and `state`).
 * @returns A `PersistHandle` with `flushNow`/`dispose` for the `onStop` teardown path.
 * @example
 * ```ts
 * deps.state.recovery.persistHandle = armPersistence(deps);
 * ```
 */
export function armPersistence(deps: SessionDeps): PersistHandle {
  let latestRecord: HostReentryRecord | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const storageKey = localStorageKey(deps.config.storageKeyPrefix, deps.state.roomCode);

  /**
   * Synchronously writes the latest retained record to `localStorage` (the `visibilitychange`/`onStop`
   * path). A no-op until a record exists.
   *
   * @example
   * ```ts
   * syncFlush();
   * ```
   */
  const syncFlush = (): void => {
    if (!latestRecord) return;
    tryLocalStorageSet(storageKey, JSON.stringify(latestRecord));
  };

  /**
   * (Re)schedules the debounced IndexedDB write `snapshotDebounceMs` into the future, coalescing rapid
   * `recordSnapshot` calls into a single durable write.
   *
   * @example
   * ```ts
   * scheduleIdbWrite();
   * ```
   */
  const scheduleIdbWrite = (): void => {
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (latestRecord) {
        writeToIdb(latestRecord, storageKey).catch(() => {
          // Durable write is best-effort; the sync localStorage path is the safety net.
        });
      }
    }, deps.config.snapshotDebounceMs);
  };

  /**
   * The `visibilitychange` handler — performs a synchronous `localStorage` write the moment the page is
   * hidden (the reliable last-moment hook on iOS/Android-TV).
   *
   * @example
   * ```ts
   * document.addEventListener("visibilitychange", onVisibilityChange);
   * ```
   */
  const onVisibilityChange = (): void => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      syncFlush();
    }
  };

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibilityChange);
  }

  const handle: PersistHandleInternal = {
    /**
     * Cancels any pending debounce and writes the latest record synchronously (the `onStop` final-persist
     * path — same `localStorage` write as `visibilitychange`).
     *
     * @example
     * ```ts
     * handle.flushNow();
     * ```
     */
    flushNow(): void {
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      syncFlush();
    },
    /**
     * Clears the debounce timer and removes the `visibilitychange` listener so no callback fires after
     * teardown.
     *
     * @example
     * ```ts
     * handle.dispose();
     * ```
     */
    dispose(): void {
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
    },
    /** @inheritdoc */
    _update(record: HostReentryRecord, scheduleIdb: boolean): void {
      latestRecord = record;
      if (scheduleIdb) scheduleIdbWrite();
    }
  };

  return handle;
}

/**
 * Records the latest authoritative snapshot for persistence (§5.1): updates the driver's retained
 * `HostReentryRecord`, (re)schedules the debounced IndexedDB write, and stamps `sSeqAtSnapshot`. The
 * payload is opaque — `session` never inspects the `Snapshot`.
 *
 * @param deps - This app's destructured per-instance pieces.
 * @param record - The full re-entry record (room code + host token + snapshot + sSeq + savedAt).
 * @example
 * ```ts
 * recordSnapshot(deps, { roomCode, hostToken, snapshot, sSeq, savedAt: Date.now() });
 * ```
 */
export function recordSnapshot(deps: SessionDeps, record: HostReentryRecord): void {
  deps.state.sSeqAtSnapshot = record.sSeq;
  const handle = deps.state.recovery.persistHandle as PersistHandleInternal | null;
  if (handle) handle._update(record, true);
}

/**
 * Reads back the persisted `HostReentryRecord` for this origin from `localStorage` on reload (§5.2).
 * Scans for the room-code-scoped re-entry key. Returns `null` when there is no record. DOM/storage
 * access is DOM-guarded.
 *
 * @param deps - This app's destructured per-instance pieces.
 * @returns The persisted `HostReentryRecord`, or `null` if absent.
 * @example
 * ```ts
 * const rec = readReentryRecord(deps);
 * ```
 */
export function readReentryRecord(deps: SessionDeps): HostReentryRecord | null {
  if (typeof localStorage === "undefined") return null;

  const entryPrefix = `${deps.config.storageKeyPrefix}.reentry.`;
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith(entryPrefix)) continue;
      const raw = tryLocalStorageGet(key);
      if (raw) return JSON.parse(raw) as HostReentryRecord;
    }
  } catch {
    // localStorage unavailable or JSON parse error — no recoverable record.
  }
  return null;
}

/**
 * `onStop` teardown for the recovery sub-domain (D14): does the final SYNCHRONOUS snapshot persist FIRST
 * (`persistHandle.flushNow()` — the same `localStorage` path as `visibilitychange`), THEN clears timers
 * and removes the `visibilitychange` listener (`persistHandle.dispose()`), nulls `recovery.timer`, and
 * clears any in-flight join timeout + settles its pending resolver (so a `joinRoom` interrupted by
 * `stop()` leaves neither a dangling 10s timer nor a hung promise — finding #3).
 * Takes the per-app `SessionState` (recovered from the `teardownRegistry` WeakMap) — NEVER a
 * module-level singleton — so it needs no `state`/`require`/`emit` (the `{ global }`-only context).
 *
 * @param state - This app's `SessionState`, looked up via `teardownRegistry.get(ctx.global)`.
 * @example
 * ```ts
 * const s = teardownRegistry.get(ctx.global);
 * if (s) teardownSession(s);
 * ```
 */
export function teardownSession(state: SessionState): void {
  const handle = state.recovery.persistHandle;
  if (handle) {
    handle.flushNow();
    handle.dispose();
    state.recovery.persistHandle = null;
  }
  if (state.recovery.timer !== null) {
    clearTimeout(state.recovery.timer);
    state.recovery.timer = null;
  }
  // A joinRoom() in flight when the app stops must not leave its reconnect timer dangling (it would
  // fire post-teardown → stale promise resolution) nor leave an awaiting joinRoom() hung forever.
  const runtime = state as unknown as SessionStateWithRuntime;
  if (runtime._joinTimeout) {
    clearTimeout(runtime._joinTimeout);
    runtime._joinTimeout = null;
  }
  if (runtime._pendingJoinResolve) {
    runtime._pendingJoinResolve({ ok: false, reason: "unreachable" });
    runtime._pendingJoinResolve = null;
  }
}
