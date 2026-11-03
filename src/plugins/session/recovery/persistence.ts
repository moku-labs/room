/**
 * @file Host-snapshot persistence driver (§5.1): a debounced IndexedDB write (~`snapshotDebounceMs`)
 * during normal play PLUS a SYNCHRONOUS `localStorage` write on `visibilitychange` (the only reliable
 * last-moment hook on iOS/Android-TV — `beforeunload`/`pagehide` are unreliable there). Produces a
 * `PersistHandle`. DOM/storage access is DOM-guarded (`typeof window`/`indexedDB`) so the
 * `inMemory`/headless path degrades gracefully. `stopSession` is the `onStop` entry point (takes
 * `SessionState`, NOT a singleton).
 * @see ../README.md
 */

import type { HostReentryRecord, SessionDeps, SessionState } from "../types";
import type { PersistHandleInternal } from "./types";

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
 * Removes a key from `localStorage` behind a DOM guard. Swallows a disabled-storage error, like the write.
 *
 * @param key - The localStorage key.
 * @example
 * ```ts
 * tryLocalStorageRemove("moku.room.reentry.G7K2QF");
 * ```
 */
function tryLocalStorageRemove(key: string): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(key);
  } catch {
    // Storage disabled — degrade gracefully.
  }
}

/**
 * Lists the `localStorage` keys up front, so the scan can remove records without shifting the indices it
 * still has to visit.
 *
 * @returns Every key in storage, or the ones read so far when storage refuses.
 * @example
 * ```ts
 * for (const key of listLocalStorageKeys()) tryLocalStorageRemove(key);
 * ```
 */
function listLocalStorageKeys(): string[] {
  const keys: string[] = [];
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key !== null) keys.push(key);
    }
  } catch {
    // Storage disabled — no recoverable record.
  }
  return keys;
}

/**
 * Parses a stored re-entry record. A value with no numeric `savedAt` counts as unparseable: its age cannot
 * be known, so it can never be restored safely.
 *
 * @param raw - The string read from `localStorage`.
 * @returns The record, or `null` when the value is not one.
 * @example
 * ```ts
 * parseStoredRecord("{not json"); // null
 * ```
 */
function parseStoredRecord(raw: string): HostReentryRecord | null {
  try {
    const parsed = JSON.parse(raw) as Partial<HostReentryRecord> | null;
    return typeof parsed?.savedAt === "number" ? (parsed as HostReentryRecord) : null;
  } catch {
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
 * Deletes the host re-entry record from IndexedDB. A no-op in headless environments (no `indexedDB`).
 *
 * @param key - The room-code-scoped storage key.
 * @returns A promise that resolves once the delete transaction completes.
 * @example
 * ```ts
 * await deleteFromIdb("moku.room.reentry.G7K2QF");
 * ```
 */
async function deleteFromIdb(key: string): Promise<void> {
  const db = await openIdb();
  if (!db) return;
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).delete(key);
    tx.addEventListener("complete", () => resolve());
    tx.addEventListener("error", () => reject(tx.error));
  });
}

/**
 * Removes a record from both stores: the `localStorage` key and the IndexedDB row. Best-effort, like the
 * writes.
 *
 * @param key - The room-code-scoped storage key.
 * @example
 * ```ts
 * removeStoredRecord("moku.room.reentry.G7K2QF");
 * ```
 */
function removeStoredRecord(key: string): void {
  tryLocalStorageRemove(key);
  deleteFromIdb(key).catch(() => {
    // Durable delete is best-effort, like the durable write.
  });
}

/**
 * Arms the persistence driver for the HOST: holds the latest record, schedules debounced IndexedDB
 * writes, and registers the synchronous `localStorage`-on-`visibilitychange` listener (§5.1). The
 * returned `PersistHandle` is stored into `deps.state.recovery.persistHandle`; the driver retains the
 * latest record internally so `flushNow()` needs no `state`. DOM/storage access is DOM-guarded.
 *
 * @param deps - This app's destructured per-instance pieces (`config` and `state`).
 * @returns A `PersistHandleInternal` with `flushNow`/`dispose` (public) plus the internal `discard` and
 *   `_update`, for the `leave()` and `onStop` teardown paths. Assignable to the public `PersistHandle | null` recovery field.
 * @example
 * ```ts
 * deps.state.recovery.persistHandle = armPersistence(deps);
 * ```
 */
export function armPersistence(deps: SessionDeps): PersistHandleInternal {
  // A reload's record stays the latest until sync hands over a new one, so an idle room still has one to flush.
  let latestRecord: HostReentryRecord | null = deps.state._reentryRecord ?? null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const storageKey = localStorageKey(deps.config.storageKeyPrefix, deps.state.roomCode);

  /**
   * Synchronously writes the latest retained record to `localStorage` (the `visibilitychange`/`onStop`
   * path), with `savedAt` set to now: the record's age counts from when this host was last alive, not from its
   * last change, so a lobby that sits idle stays resumable. A no-op until a record exists.
   *
   * @example
   * ```ts
   * syncFlush();
   * ```
   */
  const syncFlush = (): void => {
    if (!latestRecord) return;
    tryLocalStorageSet(storageKey, JSON.stringify({ ...latestRecord, savedAt: Date.now() }));
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

  // Register the synchronous visibilitychange flush before building the handle.
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibilityChange);
  }

  // Build and return the PersistHandle.
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
    discard(): void {
      latestRecord = null;
      handle.dispose();
      removeStoredRecord(storageKey);
    },
    /** @inheritdoc */
    _update(record: HostReentryRecord, scheduleIdb: boolean): void {
      latestRecord = record;
      if (scheduleIdb) scheduleIdbWrite();
    },
    /** @inheritdoc */
    _setReclaimToken(token: string): void {
      if (latestRecord) latestRecord = { ...latestRecord, reclaimToken: token };
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
  const handle = deps.state.recovery.persistHandle;
  if (handle) handle._update(record, true);
}

/**
 * Reads back the persisted `HostReentryRecord` for this origin from `localStorage` on reload (§5.2).
 * Scans for the room-code-scoped re-entry key. A record older than `config.reentryMaxAgeMs`, or one that
 * cannot be parsed, is removed from both stores and skipped. Returns `null` when no record is left.
 * DOM/storage access is DOM-guarded.
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
  const now = Date.now();
  for (const key of listLocalStorageKeys()) {
    if (!key.startsWith(entryPrefix)) continue;
    const raw = tryLocalStorageGet(key);
    if (!raw) continue;
    const record = parseStoredRecord(raw);
    if (record && now - record.savedAt <= deps.config.reentryMaxAgeMs) return record;
    removeStoredRecord(key);
  }
  return null;
}

/**
 * `onStop` entry point: the {@link teardownSession} a `leave()` also runs, plus the `onRoomEnded` callbacks. Those
 * live until the app stops, because `intent` and `sync` register once in `onInit` and must survive a `leave()`.
 *
 * @param state - This app's `SessionState`.
 * @example
 * ```ts
 * onStop: ({ state }) => stopSession(state)
 * ```
 */
export function stopSession(state: SessionState): void {
  teardownSession(state);
  state._roomEndedCallbacks?.clear();
}

/**
 * Teardown for the recovery sub-domain (D14), on `leave()` and on stop: does the final SYNCHRONOUS snapshot persist FIRST
 * (`persistHandle.flushNow()` — the same `localStorage` path as `visibilitychange`), THEN clears timers
 * and removes the `visibilitychange` listener (`persistHandle.dispose()`), nulls `recovery.timer`, clears the
 * pending close timers of refused peers, and clears any in-flight join timeout + settles its pending resolver
 * (so a `joinRoom` interrupted by `stop()` leaves neither a dangling 10s timer nor a hung promise — finding #3).
 * Takes the per-app `SessionState` (the plugin's own state, passed to `onStop`) — NEVER a
 * module-level singleton — so it needs no `require`/`emit` (absent from the teardown context).
 *
 * @param state - This app's `SessionState`.
 * @example
 * ```ts
 * teardownSession(deps.state); // in leave()
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
  // A refused peer's close timer dies here: the transport teardown closes that peer anyway.
  for (const timer of state._refuseTimers?.values() ?? []) clearTimeout(timer);
  state._refuseTimers?.clear();
  // A joinRoom() in flight when the app stops must not leave its reconnect timer dangling (it would
  // fire post-teardown → stale promise resolution) nor leave an awaiting joinRoom() hung forever.
  const runtime = state;
  if (runtime._joinTimeout) {
    clearTimeout(runtime._joinTimeout);
    runtime._joinTimeout = null;
  }
  if (runtime._pendingJoinResolve) {
    runtime._pendingJoinResolve({ ok: false, reason: "unreachable" });
    runtime._pendingJoinResolve = null;
  }
}
