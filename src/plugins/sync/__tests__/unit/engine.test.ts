/**
 * Unit tests for the per-app `SyncEngine` (`engine.ts`): slice registry, dirty-flag, sSeq monotonicity,
 * throttle coalescing (fake timers at `broadcastHz`), gap detection, subscription firing, frozen reads,
 * and the single `room:sync-ready` emit. Transport `Wire` mocked (`broadcast`/`send`/`on` as `vi.fn()`).
 * Placeholders only — filled at build.
 *
 * @file
 * @see ../../README.md
 */
import { describe, it } from "vitest";

describe("engine", () => {
  it.todo("registerSlice is idempotent for the same initial; throws on a conflicting initial");
  it.todo("mutate marks the namespace dirty; the dirty flag clears after a tick");
  it.todo("sSeq increments per non-empty tick and stamps deltas/snapshots");
  it.todo("throttle coalesces N mutates within one tick into exactly one SyncDeltaFrame");
  it.todo("skipEmptyDeltas: an empty tick produces no broadcast");
  it.todo("gap (incoming.sSeq > local.sSeq + 1) sets stale, ignores the delta");
  it.todo("onResyncRequest fires on a gap when resyncOnGap is true");
  it.todo("subscribe fires on apply and once immediately when the namespace is present");
  it.todo("read returns a frozen copy, not a live reference (spec/11 §2.4)");
  it.todo("room:sync-ready is emitted exactly once on the ready transition");
  it.todo("sendBaselineSnapshot sends a SyncSnapshotFrame to one peer via wire.send");
});
