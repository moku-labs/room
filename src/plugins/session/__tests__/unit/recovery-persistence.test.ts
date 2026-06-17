/**
 * @file Unit tests for `recovery/persistence.ts`: debounce coalesces N persistSnapshot calls into one
 * IndexedDB write within snapshotDebounceMs (fake timers); visibilitychange triggers a SYNCHRONOUS
 * localStorage write; flushNow() writes immediately; dispose() removes the listener + clears timers; the
 * record shape matches HostReentryRecord.
 */

import { describe, it } from "vitest";

describe("recovery/persistence", () => {
  it.todo("debounces N persistSnapshot calls into one IndexedDB write within snapshotDebounceMs");
  it.todo("writes synchronously to localStorage on visibilitychange");
  it.todo("flushNow() writes the latest record immediately");
  it.todo("dispose() removes the visibilitychange listener and clears timers");
  it.todo("persisted record matches the HostReentryRecord shape");
});
