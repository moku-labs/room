/**
 * @file Controller-side intent ring buffer + reconcile (§5.3/§5.4). While `phase !== "stable"` the
 * controller buffers timestamped `IntentFrame`s; the buffer is a ring capped at `intentBufferMax` (oldest
 * dropped first) and entries older than `intentBufferMaxAgeMs` are discarded on flush (lossy by design for
 * high-frequency analog intents — acceptable for the v1 party-game target). The HOST reconcile applies the
 * flushed buffer in `cSeq` order, dropping `cSeq <= lastApplied[peerId]` (§4.3 idempotence).
 * @see ../README.md
 */

import type { IntentFrame, PeerId } from "../../../contracts";
import type { BufferedIntent, SessionState } from "../types";

/**
 * Buffers one timestamped intent on the controller while the host is absent (§5.3). Enforces the ring cap
 * (`intentBufferMax`, oldest dropped first). Stamps `ts` at capture time.
 *
 * @param state - This app's mutable session state.
 * @param intent - The `IntentFrame` to buffer.
 * @param intentBufferMax - The configured ring-buffer cap.
 * @param now - Capture epoch-ms (injectable for tests).
 * @example
 * ```ts
 * bufferIntent(state, intent, config.intentBufferMax, Date.now());
 * ```
 */
export function bufferIntent(
  state: SessionState,
  intent: IntentFrame,
  intentBufferMax: number,
  now: number
): void {
  // Enforce ring cap — drop oldest first.
  while (state.recovery.buffer.length >= intentBufferMax) {
    state.recovery.buffer.shift();
  }
  state.recovery.buffer.push({ intent, ts: now });
}

/**
 * Produces the `cSeq`-ordered flush payload for a `RecoveryFlushFrame`, discarding entries older than
 * `intentBufferMaxAgeMs` (§5.4) and clearing the buffer. Lossy by design.
 *
 * @param state - This app's mutable session state.
 * @param intentBufferMaxAgeMs - Max age before an entry is discarded on flush.
 * @param now - Current epoch-ms (injectable for tests).
 * @returns The ordered, age-filtered intents ready to include in a `RecoveryFlushFrame`.
 * @example
 * ```ts
 * const buffered = drainBuffer(state, config.intentBufferMaxAgeMs, Date.now());
 * ```
 */
export function drainBuffer(
  state: SessionState,
  intentBufferMaxAgeMs: number,
  now: number
): readonly BufferedIntent[] {
  const cutoff = now - intentBufferMaxAgeMs;
  const fresh = state.recovery.buffer.filter(entry => entry.ts >= cutoff);
  // Sort by cSeq ascending for idempotent reconcile.
  fresh.sort((a, b) => a.intent.cSeq - b.intent.cSeq);
  state.recovery.buffer = [];
  return fresh;
}

/**
 * HOST-side idempotent reconcile of a flushed controller buffer (§4.3): returns the subset of intents to
 * actually apply, dropping any `cSeq <= lastApplied` so a reconnect/flush never double-applies.
 *
 * @param buffered - The flushed, `cSeq`-ordered intents from a `RecoveryFlushFrame`.
 * @param _peerId - The controller the buffer came from (for logging context; not used in the filter — cSeq is the only discriminant).
 * @param lastApplied - The host's `lastApplied[peerId]` high-water mark.
 * @returns The subset of intents with `cSeq > lastApplied`, ready to hand to the intent/sync layer.
 * @example
 * ```ts
 * const fresh = reconcileFlush(frame.buffered, peerId, lastApplied[peerId] ?? 0);
 * ```
 */
export function reconcileFlush(
  buffered: readonly BufferedIntent[],
  _peerId: PeerId,
  lastApplied: number
): readonly IntentFrame[] {
  // _peerId is accepted for logging context; the actual drop is based on cSeq vs lastApplied.
  return buffered.filter(entry => entry.intent.cSeq > lastApplied).map(entry => entry.intent);
}
