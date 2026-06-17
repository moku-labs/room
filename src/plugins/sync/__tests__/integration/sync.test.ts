/**
 * Integration tests for `syncPlugin` — full plugin wiring via `createApp` on the `inMemory()` signaling
 * adapter (D13 — no real `RTCPeerConnection`, deterministic). One "stage" app + N "controller" apps share
 * the in-process bus; driven by direct `app.sync.*()` calls and asserted on the synced replica. Covers
 * single-shared-engine (D14), late-join, gap/resync, recovery round-trip, lifecycle, and per-instance
 * teardown. Placeholders only — filled at build.
 *
 * @file
 * @see ../../README.md
 */
import { describe, it } from "vitest";

describe("sync integration (inMemory)", () => {
  it.todo(
    "host registerSlice + mutate + start → controller read(ns) equals the authoritative cells"
  );
  it.todo("room:sync-ready is observed on the controller's first applied snapshot");
  it.todo(
    "single shared engine (D14): a subscribe before the first frame fires on a host mutate + tick"
  );
  it.todo(
    "late-join: a peer joining after state exists gets a baseline snapshot via room:peer-joined"
  );
  it.todo("gap/resync: a dropped delta → controller stale → onResyncRequest → host re-baselines");
  it.todo(
    "recovery round-trip: exportSnapshot → new host importSnapshot → controllers reconcile to sSeq"
  );
  it.todo(
    "lifecycle: start schedules the throttle timer; stop clears it (no broadcast after stop)"
  );
  it.todo("per-instance teardown (D14): stop app1 only → app1 loop stops, app2 keeps broadcasting");
});
