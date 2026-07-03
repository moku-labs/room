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
 * Default ms before an unacked live intent's FIRST retransmit (the wait doubles per attempt). Sub-RTT
 * on a couch LAN never fires it; a real drop heals after ~1 s — the cadence the app-level self-heal
 * watchdogs used.
 */
const DEFAULT_ACK_TIMEOUT_MS = 1000;

/**
 * Default bounded retransmit budget. With the 1 s base and doubling backoff the total silence budget is
 * 1+2+4+8 = 15 s — comfortably spanning the ~10 s heartbeat dead-peer window, so a genuinely dead wire
 * surfaces through EITHER `room:intent-undeliverable` or the §5 recovery path, whichever trips first.
 */
const DEFAULT_MAX_RETRANSMITS = 3;

/**
 * The typed default `intentPlugin` config: a 256-entry, 10-second controller-side reconnect-buffer
 * window, plus the at-least-once live-delivery budget (1 s ack timeout, 3 bounded retransmits with
 * doubling backoff). There is no validation knob — shape-checking is correctness-only and always on (D6).
 *
 * @example
 * ```ts
 * const cfg = DEFAULT_INTENT_CONFIG;
 * cfg.bufferCap; // 256
 * cfg.ackTimeoutMs; // 1000
 * ```
 */
export const DEFAULT_INTENT_CONFIG: IntentConfig = {
  bufferCap: DEFAULT_BUFFER_CAP,
  bufferMaxAgeMs: DEFAULT_BUFFER_MAX_AGE_MS,
  ackTimeoutMs: DEFAULT_ACK_TIMEOUT_MS,
  maxRetransmits: DEFAULT_MAX_RETRANSMITS
};
