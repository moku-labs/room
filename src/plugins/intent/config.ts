/**
 * @file Typed default config for `intentPlugin` (R6 — no inline `as` in the `createPlugin` spec).
 * @see README.md
 *
 * `DEFAULT_INTENT_CONFIG` is the typed default factory result: a 256-entry, 10-second controller-side
 * reconnect-buffer window. Keeping this a typed const keeps the `createPlugin` spec object free of inline
 * assertions/literals (contracts invariant checklist).
 */
import type { IntentConfig } from "./types";

/** Default controller-side reconnect-buffer capacity (entries) before the oldest are FIFO-dropped. */
const DEFAULT_BUFFER_CAP = 256;

/** Default max age (ms) a buffered intent is kept before prune; `>=` the ~10 s reconnect timeout. */
const DEFAULT_BUFFER_MAX_AGE_MS = 10_000;

/**
 * The typed default `intentPlugin` config: a 256-entry, 10-second controller-side reconnect-buffer
 * window. There is no validation knob — shape-checking is correctness-only and always on (D6).
 *
 * @example
 * ```ts
 * const cfg = DEFAULT_INTENT_CONFIG;
 * cfg.bufferCap; // 256
 * ```
 */
export const DEFAULT_INTENT_CONFIG: IntentConfig = {
  bufferCap: DEFAULT_BUFFER_CAP,
  bufferMaxAgeMs: DEFAULT_BUFFER_MAX_AGE_MS
};
