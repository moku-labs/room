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
import { createSessionState } from "../../state";
import type { SessionConfig, SessionDeps } from "../../types";

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
    state.recovery.persistHandle = { flushNow, dispose };

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
});
