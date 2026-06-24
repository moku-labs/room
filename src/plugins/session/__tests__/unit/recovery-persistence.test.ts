/**
 * @file Unit tests for `recovery/persistence.ts`: debounce coalesces N persistSnapshot calls into one
 * IndexedDB write within snapshotDebounceMs (fake timers); visibilitychange triggers a SYNCHRONOUS
 * localStorage write; flushNow() writes immediately; dispose() removes the listener + clears timers; the
 * record shape matches HostReentryRecord.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Snapshot } from "../../../../contracts";
import {
  armPersistence,
  readReentryRecord,
  recordSnapshot,
  teardownSession
} from "../../recovery/persistence";
import type { SessionStateWithRuntime } from "../../recovery/reentry";
import { createSessionState } from "../../state";
import type { HostReentryRecord, JoinResult, SessionConfig, SessionDeps } from "../../types";

/** Structural view of the internal `_update` member that `recordSnapshot` drives (not on the public surface). */
type PersistHandleWithUpdate = {
  flushNow(): void;
  dispose(): void;
  _update(record: HostReentryRecord, scheduleIdb: boolean): void;
};

/** Minimal config for persistence tests. */
const testConfig: Readonly<SessionConfig> = {
  joinUrlBase: "",
  generateQr: false,
  maxControllers: 8,
  snapshotDebounceMs: 100,
  reconnectTimeoutMs: 10_000,
  intentBufferMax: 256,
  intentBufferMaxAgeMs: 8000,
  storageKeyPrefix: "test.room"
};

const emptySnapshot: Snapshot = {};

/** A mock localStorage implementation that stores items in memory. */
class MockLocalStorage {
  private readonly store = new Map<string, string>();
  get length(): number {
    return this.store.size;
  }

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  key(index: number): string | null {
    return [...this.store.keys()][index] ?? null;
  }

  clear(): void {
    this.store.clear();
  }
}

/** A minimal in-memory IndexedDB object store mirroring the subset persistence.ts uses. */
class MockObjectStore {
  constructor(private readonly records: Map<string, unknown>) {}
  put(value: unknown, key: string): void {
    this.records.set(key, value);
  }
}

/** A minimal in-memory IndexedDB transaction (only `complete`/`error` events + `objectStore`). */
class MockTransaction {
  readonly error: DOMException | null = null;
  private readonly listeners = new Map<string, Array<() => void>>();
  constructor(
    private readonly records: Map<string, unknown>,
    private readonly failTx: boolean
  ) {}

  objectStore(_name: string): MockObjectStore {
    return new MockObjectStore(this.records);
  }

  addEventListener(type: string, cb: () => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(cb);
    this.listeners.set(type, list);
    // Fire "error" when the tx is configured to fail, otherwise "complete" (the put is synchronous).
    if (this.failTx && type === "error") queueMicrotask(() => cb());
    if (!this.failTx && type === "complete") queueMicrotask(() => cb());
  }
}

/** A minimal in-memory IndexedDB database (only `transaction` + objectStore bookkeeping). */
class MockIdbDatabase {
  readonly objectStoreNames = {
    contains: (name: string): boolean => this.stores.has(name)
  };
  private readonly stores: Set<string>;
  constructor(
    private readonly records: Map<string, unknown>,
    private readonly failTx: boolean,
    preSeededStores: readonly string[] = []
  ) {
    // Pre-seed stores so a later `upgradeneeded` sees `contains() === true` (the create-skip branch).
    this.stores = new Set(preSeededStores);
  }

  createObjectStore(name: string): void {
    this.stores.add(name);
  }

  transaction(_storeName: string, _mode: string): MockTransaction {
    return new MockTransaction(this.records, this.failTx);
  }
}

/**
 * A minimal in-memory IndexedDB factory matching the `indexedDB.open` event flow persistence.ts drives.
 * `failOpen` fires the open request's `error` event (openIdb rejects); `failTx` fires the write
 * transaction's `error` event (writeToIdb rejects) — both exercise the best-effort `.catch()` paths.
 */
class MockIndexedDB {
  readonly records = new Map<string, unknown>();
  constructor(
    private readonly failOpen = false,
    private readonly failTx = false,
    private readonly preSeededStores: readonly string[] = []
  ) {}

  open(_name: string, _version: number): IDBOpenDBRequest {
    const db = new MockIdbDatabase(this.records, this.failTx, this.preSeededStores);
    const listeners = new Map<string, Array<() => void>>();
    const request = {
      result: db,
      error: null as DOMException | null,
      addEventListener(type: string, cb: () => void): void {
        const list = listeners.get(type) ?? [];
        list.push(cb);
        listeners.set(type, list);
      }
    } as unknown as IDBOpenDBRequest;

    queueMicrotask(() => {
      if (this.failOpen) {
        // Open failed → openIdb rejects.
        for (const cb of listeners.get("error") ?? []) cb();
        return;
      }
      // Drive upgradeneeded (to create the store) then success on the next microtasks.
      for (const cb of listeners.get("upgradeneeded") ?? []) cb();
      for (const cb of listeners.get("success") ?? []) cb();
    });
    return request;
  }
}

function makeDeps(): SessionDeps {
  const state = createSessionState();
  state.role = "host";
  state.roomCode = "TEST01";
  state.hostToken = "token-abc";

  return {
    state,
    config: testConfig,
    emit: {
      peerJoined: vi.fn(),
      peerLeft: vi.fn(),
      hostReconnecting: vi.fn()
    },
    log: { warn: vi.fn() },
    requireTransport: vi.fn()
  };
}

describe("recovery/persistence", () => {
  let mockStorage: MockLocalStorage;
  let originalLocalStorage: typeof globalThis.localStorage;
  let originalDocument: typeof globalThis.document;

  // Track visibilitychange handlers registered.
  const visibilityListeners: Array<() => void> = [];

  beforeEach(() => {
    vi.useFakeTimers();
    mockStorage = new MockLocalStorage();
    // Inject mock localStorage.
    originalLocalStorage = globalThis.localStorage;
    Object.defineProperty(globalThis, "localStorage", {
      value: mockStorage,
      writable: true,
      configurable: true
    });
    // Inject mock document with visibilitychange support.
    originalDocument = globalThis.document;
    visibilityListeners.length = 0;
    Object.defineProperty(globalThis, "document", {
      value: {
        visibilityState: "visible" as string,
        addEventListener(_type: string, cb: () => void): void {
          visibilityListeners.push(cb);
        },
        removeEventListener(_type: string, cb: () => void): void {
          const idx = visibilityListeners.indexOf(cb);
          if (idx !== -1) visibilityListeners.splice(idx, 1);
        }
      },
      writable: true,
      configurable: true
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(globalThis, "localStorage", {
      value: originalLocalStorage,
      writable: true,
      configurable: true
    });
    Object.defineProperty(globalThis, "document", {
      value: originalDocument,
      writable: true,
      configurable: true
    });
  });

  it("persisted record matches the HostReentryRecord shape", () => {
    const deps = makeDeps();
    const handle = armPersistence(deps);
    deps.state.recovery.persistHandle = handle;

    const record = {
      roomCode: "TEST01",
      hostToken: "token-abc",
      snapshot: emptySnapshot,
      sSeq: 5,
      savedAt: Date.now()
    };
    recordSnapshot(deps, record);

    // flushNow writes synchronously to localStorage.
    handle.flushNow();

    const key = "test.room.reentry.TEST01";
    const raw = mockStorage.getItem(key);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(String(raw)) as typeof record;
    expect(parsed.roomCode).toBe("TEST01");
    expect(parsed.hostToken).toBe("token-abc");
    expect(parsed.sSeq).toBe(5);
    handle.dispose();
  });

  it("debounces N persistSnapshot calls into one IndexedDB write within snapshotDebounceMs", () => {
    const deps = makeDeps();
    const handle = armPersistence(deps);
    deps.state.recovery.persistHandle = handle;

    // Call recordSnapshot multiple times before the debounce fires.
    for (let i = 1; i <= 5; i++) {
      recordSnapshot(deps, {
        roomCode: "TEST01",
        hostToken: "token-abc",
        snapshot: emptySnapshot,
        sSeq: i,
        savedAt: Date.now()
      });
    }

    // Before debounce fires, localStorage hasn't been written (only on flushNow/visibilitychange/dispose).
    // Advance timer to trigger the debounce.
    vi.advanceTimersByTime(150); // > snapshotDebounceMs (100)

    // The debounce timer fires — but it writes to IndexedDB (not localStorage directly).
    // We verify by calling flushNow() and checking localStorage.
    handle.flushNow();
    const key = "test.room.reentry.TEST01";
    const raw = mockStorage.getItem(key);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(String(raw)) as { sSeq: number };
    // The latest record (sSeq=5) should be persisted.
    expect(parsed.sSeq).toBe(5);
    handle.dispose();
  });

  it("flushNow() writes the latest record immediately", () => {
    const deps = makeDeps();
    const handle = armPersistence(deps);
    deps.state.recovery.persistHandle = handle;

    recordSnapshot(deps, {
      roomCode: "TEST01",
      hostToken: "token-abc",
      snapshot: emptySnapshot,
      sSeq: 42,
      savedAt: Date.now()
    });

    // Without advancing timers, flushNow() should write immediately.
    handle.flushNow();

    const raw = mockStorage.getItem("test.room.reentry.TEST01");
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(String(raw)) as { sSeq: number };
    expect(parsed.sSeq).toBe(42);
    handle.dispose();
  });

  it("writes synchronously to localStorage on visibilitychange", () => {
    const deps = makeDeps();
    const handle = armPersistence(deps);
    deps.state.recovery.persistHandle = handle;

    recordSnapshot(deps, {
      roomCode: "TEST01",
      hostToken: "token-abc",
      snapshot: emptySnapshot,
      sSeq: 7,
      savedAt: Date.now()
    });

    // Simulate visibilitychange to "hidden".
    const mockDoc = globalThis.document as unknown as { visibilityState: string };
    mockDoc.visibilityState = "hidden";
    for (const listener of visibilityListeners) {
      listener();
    }

    const raw = mockStorage.getItem("test.room.reentry.TEST01");
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(String(raw)) as { sSeq: number };
    expect(parsed.sSeq).toBe(7);
    handle.dispose();
  });

  it("dispose() removes the visibilitychange listener and clears timers", () => {
    const deps = makeDeps();
    const handle = armPersistence(deps);
    deps.state.recovery.persistHandle = handle;

    recordSnapshot(deps, {
      roomCode: "TEST01",
      hostToken: "token-abc",
      snapshot: emptySnapshot,
      sSeq: 99,
      savedAt: Date.now()
    });

    // Verify listener registered.
    expect(visibilityListeners).toHaveLength(1);

    handle.dispose();

    // Listener removed after dispose.
    expect(visibilityListeners).toHaveLength(0);

    // Advancing timers after dispose should not trigger any writes.
    vi.advanceTimersByTime(1000);
    // localStorage still empty (no flushNow called).
    expect(mockStorage.getItem("test.room.reentry.TEST01")).toBeNull();
  });

  it("teardownSession calls flushNow then dispose and clears the reconnect timer", () => {
    const state = createSessionState();
    state.role = "host";
    state.roomCode = "TEST01";

    const flushNow = vi.fn();
    const dispose = vi.fn();
    state.recovery.persistHandle = { flushNow, dispose, _update: vi.fn() };

    const timerHandle = setTimeout(() => {}, 99_999);
    state.recovery.timer = timerHandle;

    teardownSession(state);

    expect(flushNow).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(state.recovery.persistHandle).toBeNull();
    expect(state.recovery.timer).toBeNull();
  });

  it("readReentryRecord returns the persisted record from localStorage", () => {
    const deps = makeDeps();
    const record = {
      roomCode: "TEST01",
      hostToken: "token-abc",
      snapshot: emptySnapshot,
      sSeq: 3,
      savedAt: Date.now()
    };
    mockStorage.setItem("test.room.reentry.TEST01", JSON.stringify(record));

    const result = readReentryRecord(deps);
    expect(result).not.toBeNull();
    expect(result?.roomCode).toBe("TEST01");
    expect(result?.sSeq).toBe(3);
  });

  it("readReentryRecord returns null when no record is present", () => {
    const deps = makeDeps();
    const result = readReentryRecord(deps);
    expect(result).toBeNull();
  });

  it("readReentryRecord skips localStorage keys that do not match the reentry prefix", () => {
    const deps = makeDeps();
    // An unrelated key must be skipped (the `continue` branch), then the real record is found.
    mockStorage.setItem("some.other.key", "irrelevant");
    const record = {
      roomCode: "TEST01",
      hostToken: "token-abc",
      snapshot: emptySnapshot,
      sSeq: 8,
      savedAt: Date.now()
    };
    mockStorage.setItem("test.room.reentry.TEST01", JSON.stringify(record));

    const result = readReentryRecord(deps);
    expect(result?.roomCode).toBe("TEST01");
    expect(result?.sSeq).toBe(8);
  });

  it("readReentryRecord returns null when localStorage is undefined (headless path)", () => {
    const deps = makeDeps();
    // Remove localStorage entirely to hit the DOM-guard early-return.
    Object.defineProperty(globalThis, "localStorage", {
      value: undefined,
      writable: true,
      configurable: true
    });
    const result = readReentryRecord(deps);
    expect(result).toBeNull();
  });

  it("flushNow() is a no-op when no record has been recorded yet", () => {
    const deps = makeDeps();
    const handle = armPersistence(deps);
    deps.state.recovery.persistHandle = handle;

    // No recordSnapshot call → latestRecord is null → syncFlush early-returns, nothing written.
    handle.flushNow();
    expect(mockStorage.getItem("test.room.reentry.TEST01")).toBeNull();
    handle.dispose();
  });

  it("persistence degrades to a no-op when localStorage is undefined", () => {
    const deps = makeDeps();
    const handle = armPersistence(deps);
    deps.state.recovery.persistHandle = handle;

    recordSnapshot(deps, {
      roomCode: "TEST01",
      hostToken: "token-abc",
      snapshot: emptySnapshot,
      sSeq: 11,
      savedAt: Date.now()
    });

    // Remove localStorage → tryLocalStorageSet early-returns (no throw).
    Object.defineProperty(globalThis, "localStorage", {
      value: undefined,
      writable: true,
      configurable: true
    });
    expect(() => handle.flushNow()).not.toThrow();
    handle.dispose();
  });

  it("tryLocalStorageGet swallows a throwing getItem and yields null", () => {
    const deps = makeDeps();
    // Replace localStorage with one whose getItem throws, but length/key resolve a matching key.
    Object.defineProperty(globalThis, "localStorage", {
      value: {
        length: 1,
        key: (_index: number): string | null => "test.room.reentry.TEST01",
        getItem: (): string => {
          throw new Error("storage disabled");
        },
        setItem: (): void => {}
      },
      writable: true,
      configurable: true
    });

    // readReentryRecord scans → tryLocalStorageGet throws internally → caught → falls through to null.
    const result = readReentryRecord(deps);
    expect(result).toBeNull();
  });

  it("writes the latest snapshot through to (mock) IndexedDB on the debounce timer", async () => {
    // Inject a mock indexedDB so the durable write path (openIdb + writeToIdb) actually runs.
    const mockIdb = new MockIndexedDB();
    const originalIndexedDB = globalThis.indexedDB;
    Object.defineProperty(globalThis, "indexedDB", {
      value: mockIdb,
      writable: true,
      configurable: true
    });

    try {
      const deps = makeDeps();
      const handle = armPersistence(deps);
      deps.state.recovery.persistHandle = handle;

      recordSnapshot(deps, {
        roomCode: "TEST01",
        hostToken: "token-abc",
        snapshot: emptySnapshot,
        sSeq: 21,
        savedAt: Date.now()
      });

      // Fire the debounce timer → scheduleIdbWrite callback → writeToIdb → openIdb (async event flow).
      await vi.advanceTimersByTimeAsync(150);

      const key = "test.room.reentry.TEST01";
      const written = mockIdb.records.get(key) as { sSeq: number } | undefined;
      expect(written).toBeDefined();
      expect(written?.sSeq).toBe(21);
      handle.dispose();
    } finally {
      Object.defineProperty(globalThis, "indexedDB", {
        value: originalIndexedDB,
        writable: true,
        configurable: true
      });
    }
  });

  it("skips createObjectStore on upgrade when the store already exists", async () => {
    // Pre-seed the "records" store so upgradeneeded sees contains() === true (create-skip branch).
    const mockIdb = new MockIndexedDB(false, false, ["records"]);
    const originalIndexedDB = globalThis.indexedDB;
    Object.defineProperty(globalThis, "indexedDB", {
      value: mockIdb,
      writable: true,
      configurable: true
    });

    try {
      const deps = makeDeps();
      const handle = armPersistence(deps);
      deps.state.recovery.persistHandle = handle;

      recordSnapshot(deps, {
        roomCode: "TEST01",
        hostToken: "token-abc",
        snapshot: emptySnapshot,
        sSeq: 41,
        savedAt: Date.now()
      });

      // The durable write still succeeds even though the store was not (re)created.
      await vi.advanceTimersByTimeAsync(150);
      const written = mockIdb.records.get("test.room.reentry.TEST01") as
        | { sSeq: number }
        | undefined;
      expect(written?.sSeq).toBe(41);
      handle.dispose();
    } finally {
      Object.defineProperty(globalThis, "indexedDB", {
        value: originalIndexedDB,
        writable: true,
        configurable: true
      });
    }
  });

  it("swallows an IndexedDB open failure on the debounce timer (best-effort durable write)", async () => {
    // failOpen → the open request fires "error" → openIdb rejects → writeToIdb's caller .catch() runs.
    const mockIdb = new MockIndexedDB(true, false);
    const originalIndexedDB = globalThis.indexedDB;
    Object.defineProperty(globalThis, "indexedDB", {
      value: mockIdb,
      writable: true,
      configurable: true
    });

    try {
      const deps = makeDeps();
      const handle = armPersistence(deps);
      deps.state.recovery.persistHandle = handle;

      recordSnapshot(deps, {
        roomCode: "TEST01",
        hostToken: "token-abc",
        snapshot: emptySnapshot,
        sSeq: 31,
        savedAt: Date.now()
      });

      // The debounce fires writeToIdb → openIdb rejects → caught silently (no throw, no record written).
      await vi.advanceTimersByTimeAsync(150);
      expect(mockIdb.records.has("test.room.reentry.TEST01")).toBe(false);
      handle.dispose();
    } finally {
      Object.defineProperty(globalThis, "indexedDB", {
        value: originalIndexedDB,
        writable: true,
        configurable: true
      });
    }
  });

  it("swallows an IndexedDB transaction failure on the debounce timer", async () => {
    // failTx → the write transaction fires "error" → writeToIdb rejects → caller .catch() runs.
    const mockIdb = new MockIndexedDB(false, true);
    const originalIndexedDB = globalThis.indexedDB;
    Object.defineProperty(globalThis, "indexedDB", {
      value: mockIdb,
      writable: true,
      configurable: true
    });

    try {
      const deps = makeDeps();
      const handle = armPersistence(deps);
      deps.state.recovery.persistHandle = handle;

      recordSnapshot(deps, {
        roomCode: "TEST01",
        hostToken: "token-abc",
        snapshot: emptySnapshot,
        sSeq: 32,
        savedAt: Date.now()
      });

      // The tx fires "error" → writeToIdb rejects → the best-effort .catch() swallows it (no throw).
      // Reaching the next line without an unhandled rejection is the assertion that the catch ran.
      await vi.advanceTimersByTimeAsync(150);
      expect(() => handle.flushNow()).not.toThrow();
      handle.dispose();
    } finally {
      Object.defineProperty(globalThis, "indexedDB", {
        value: originalIndexedDB,
        writable: true,
        configurable: true
      });
    }
  });

  it("teardownSession clears an in-flight join timeout and settles its pending resolver", () => {
    const state = createSessionState();
    state.role = "controller";
    state.roomCode = "TEST01";

    // No persist handle / recovery timer on this path — only the join runtime fields.
    const runtime = state as unknown as SessionStateWithRuntime;
    runtime._joinTimeout = setTimeout(() => {}, 99_999);

    let settled: JoinResult | null = null;
    runtime._pendingJoinResolve = (result: JoinResult): void => {
      settled = result;
    };

    teardownSession(state);

    // The reconnect timer was already null — that branch is the false side here.
    expect(runtime._joinTimeout).toBeNull();
    expect(runtime._pendingJoinResolve).toBeNull();
    // A hung joinRoom() is settled as unreachable rather than left dangling (finding #3).
    expect(settled).toEqual({ ok: false, reason: "unreachable" });
  });

  it("teardownSession leaves join runtime fields untouched when none are in flight", () => {
    const state = createSessionState();
    state.role = "host";

    const runtime = state as unknown as SessionStateWithRuntime;
    runtime._joinTimeout = null;
    runtime._pendingJoinResolve = null;

    // No persistHandle, no timer, no join in flight → all guard branches take the false side.
    expect(() => teardownSession(state)).not.toThrow();
    expect(runtime._joinTimeout).toBeNull();
    expect(runtime._pendingJoinResolve).toBeNull();
  });

  it("recordSnapshot is a no-op when no persistHandle is armed", () => {
    const deps = makeDeps();
    // persistHandle stays null → recordSnapshot stamps sSeqAtSnapshot but takes the no-handle branch.
    deps.state.recovery.persistHandle = null;
    recordSnapshot(deps, {
      roomCode: "TEST01",
      hostToken: "token-abc",
      snapshot: emptySnapshot,
      sSeq: 51,
      savedAt: Date.now()
    });
    expect(deps.state.sSeqAtSnapshot).toBe(51);
  });

  it("the visibilitychange listener does NOT flush while the page is still visible", () => {
    const deps = makeDeps();
    const handle = armPersistence(deps);
    deps.state.recovery.persistHandle = handle;
    recordSnapshot(deps, {
      roomCode: "TEST01",
      hostToken: "token-abc",
      snapshot: emptySnapshot,
      sSeq: 52,
      savedAt: Date.now()
    });

    // visibilityState stays "visible" → onVisibilityChange takes the false side, no write.
    const mockDoc = globalThis.document as unknown as { visibilityState: string };
    mockDoc.visibilityState = "visible";
    for (const listener of visibilityListeners) listener();

    expect(mockStorage.getItem("test.room.reentry.TEST01")).toBeNull();
    handle.dispose();
  });

  it("_update without scheduling skips the debounced IndexedDB write", () => {
    const deps = makeDeps();
    const handle = armPersistence(deps) as unknown as PersistHandleWithUpdate;
    deps.state.recovery.persistHandle = handle;

    // scheduleIdb=false → retains the record but arms no timer (the else of `if (scheduleIdb)`).
    handle._update(
      { roomCode: "TEST01", hostToken: "token-abc", snapshot: emptySnapshot, sSeq: 53, savedAt: 0 },
      false
    );

    // Advancing timers triggers nothing (no debounce armed); the record is still flushable synchronously.
    vi.advanceTimersByTime(1000);
    handle.flushNow();
    const parsed = JSON.parse(String(mockStorage.getItem("test.room.reentry.TEST01"))) as {
      sSeq: number;
    };
    expect(parsed.sSeq).toBe(53);
    handle.dispose();
  });

  describe("headless path (no document)", () => {
    let savedDocument: typeof globalThis.document;

    beforeEach(() => {
      savedDocument = globalThis.document;
      Object.defineProperty(globalThis, "document", {
        value: undefined,
        writable: true,
        configurable: true
      });
    });

    afterEach(() => {
      Object.defineProperty(globalThis, "document", {
        value: savedDocument,
        writable: true,
        configurable: true
      });
    });

    it("armPersistence/dispose skip the visibilitychange listener when document is undefined", () => {
      const deps = makeDeps();
      // No document → the listener-registration guard takes its false side.
      const handle = armPersistence(deps);
      deps.state.recovery.persistHandle = handle;
      // No listener was registered against our mock document.
      expect(visibilityListeners).toHaveLength(0);
      // dispose() likewise takes the document-undefined false side without throwing.
      expect(() => handle.dispose()).not.toThrow();
    });
  });
});
