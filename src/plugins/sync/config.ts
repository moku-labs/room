/**
 * @file Typed default config for `syncPlugin` (R6 — no inline `as` in the `createPlugin` spec).
 * @see README.md
 *
 * `DEFAULT_SYNC_CONFIG` is the typed default factory result for the verified couch profile: a 30 Hz
 * authoritative broadcast (decoupled from the 60 Hz game loop), idle ticks skipped, a bounded per-frame
 * delta size, and gap-resync on. Keeping this a typed const keeps the `createPlugin` spec object free of
 * inline assertions (contracts invariant checklist).
 */
import type { Config } from "./types";

/** Default authoritative broadcast rate in Hz; verified safe band 20-30 Hz (contracts section 4.3). */
const DEFAULT_BROADCAST_HZ = 30;

/** Default max `Op` cells per `SyncDeltaFrame` before an extra frame is forced (contracts section 2.3). */
const DEFAULT_MAX_OPS_PER_DELTA = 512;

/**
 * Default ms between a not-yet-ready replica's baseline re-requests (`sync-resync` while `ready` is
 * false). Matches the ~1 s heal cadence of the delta-paced stale retry and intent's first retransmit —
 * a dropped join `sync-snap` on an idle (pre-game) wire heals after ~1 s instead of wedging.
 */
const DEFAULT_BASELINE_RETRY_MS = 1000;

/**
 * The typed default `syncPlugin` config. All fields have safe defaults (the verified couch profile), so
 * composing `[stagePlugin]` / `[controllerPlugin]` needs zero overrides.
 *
 * @example
 * ```ts
 * const cfg = DEFAULT_SYNC_CONFIG;
 * cfg.broadcastHz; // 30
 * ```
 */
export const DEFAULT_SYNC_CONFIG: Config = {
  broadcastHz: DEFAULT_BROADCAST_HZ,
  skipEmptyDeltas: true,
  maxOpsPerDelta: DEFAULT_MAX_OPS_PER_DELTA,
  resyncOnGap: true,
  baselineRetryMs: DEFAULT_BASELINE_RETRY_MS
};
