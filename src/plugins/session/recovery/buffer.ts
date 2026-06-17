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
 * @throws {Error} Always — skeleton stub.
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
  throw new Error("not implemented");
}

/**
 * Produces the `cSeq`-ordered flush payload for a `RecoveryFlushFrame`, discarding entries older than
 * `intentBufferMaxAgeMs` (§5.4) and clearing the buffer. Lossy by design.
 *
 * @param state - This app's mutable session state.
 * @param intentBufferMaxAgeMs - Max age before an entry is discarded on flush.
 * @param now - Current epoch-ms (injectable for tests).
 * @throws {Error} Always — skeleton stub.
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
  throw new Error("not implemented");
}

/**
 * HOST-side idempotent reconcile of a flushed controller buffer (§4.3): returns the subset of intents to
 * actually apply, dropping any `cSeq <= lastApplied` so a reconnect/flush never double-applies.
 *
 * @param buffered - The flushed, `cSeq`-ordered intents from a `RecoveryFlushFrame`.
 * @param peerId - The controller the buffer came from.
 * @param lastApplied - The host's `lastApplied[peerId]` high-water mark.
 * @throws {Error} Always — skeleton stub.
 * @example
 * ```ts
 * const fresh = reconcileFlush(frame.buffered, peerId, lastApplied[peerId] ?? 0);
 * ```
 */
export function reconcileFlush(
  buffered: readonly BufferedIntent[],
  peerId: PeerId,
  lastApplied: number
): readonly IntentFrame[] {
  throw new Error("not implemented");
}
