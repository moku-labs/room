/**
 * @file Unit tests for `recovery/buffer.ts`: controller buffers IntentFrames with timestamps while
 * phase !== "stable"; ring-buffer cap (intentBufferMax) drops oldest; entries older than
 * intentBufferMaxAgeMs are discarded on flush; flush payload is cSeq-ordered; host-side reconcile drops
 * cSeq <= lastApplied[peerId] (idempotence, §4.3).
 */

import { describe, expect, it } from "vitest";
import type { IntentFrame } from "../../../transport/protocol";
import { bufferIntent, drainBuffer, reconcileFlush } from "../../recovery/buffer";
import { createSessionState } from "../../state";
import type { BufferedIntent } from "../../types";

function makeIntent(cSeq: number, name = "press"): IntentFrame {
  return { t: "intent", name, payload: { button: "A" }, cSeq };
}

describe("recovery/buffer", () => {
  it("buffers IntentFrames with capture timestamps while phase !== stable", () => {
    const state = createSessionState();
    state.recovery.phase = "host-absent";
    const intent = makeIntent(1);
    bufferIntent(state, intent, 256, 1000);
    expect(state.recovery.buffer).toHaveLength(1);
    expect(state.recovery.buffer[0]).toEqual({ intent, ts: 1000 });
  });

  it("drops the oldest entry when the ring cap (intentBufferMax) is exceeded", () => {
    const state = createSessionState();
    // Fill exactly at cap.
    for (let i = 1; i <= 3; i++) {
      bufferIntent(state, makeIntent(i), 3, i * 1000);
    }
    expect(state.recovery.buffer).toHaveLength(3);
    // Adding a 4th entry should drop the oldest (cSeq=1).
    bufferIntent(state, makeIntent(4), 3, 4000);
    expect(state.recovery.buffer).toHaveLength(3);
    expect(state.recovery.buffer[0]?.intent.cSeq).toBe(2); // cSeq=1 dropped
    expect(state.recovery.buffer[2]?.intent.cSeq).toBe(4);
  });

  it("discards entries older than intentBufferMaxAgeMs on flush", () => {
    const state = createSessionState();
    // Add entries at different timestamps.
    bufferIntent(state, makeIntent(1), 256, 1000); // old
    bufferIntent(state, makeIntent(2), 256, 5000); // old
    bufferIntent(state, makeIntent(3), 256, 9000); // fresh (now=10000, maxAge=4000 → cutoff=6000)
    bufferIntent(state, makeIntent(4), 256, 9500); // fresh

    const drained = drainBuffer(state, 4000, 10_000);
    // Entries with ts < 10000 - 4000 = 6000 should be discarded.
    expect(drained).toHaveLength(2);
    expect(drained[0]?.intent.cSeq).toBe(3);
    expect(drained[1]?.intent.cSeq).toBe(4);
    // Buffer is cleared.
    expect(state.recovery.buffer).toHaveLength(0);
  });

  it("produces a cSeq-ordered flush payload", () => {
    const state = createSessionState();
    // Add intents out of order.
    bufferIntent(state, makeIntent(3), 256, 9000);
    bufferIntent(state, makeIntent(1), 256, 9000);
    bufferIntent(state, makeIntent(2), 256, 9000);

    const drained = drainBuffer(state, 10_000, 10_000);
    expect(drained).toHaveLength(3);
    expect(drained[0]?.intent.cSeq).toBe(1);
    expect(drained[1]?.intent.cSeq).toBe(2);
    expect(drained[2]?.intent.cSeq).toBe(3);
  });

  it("host reconcile drops cSeq <= lastApplied[peerId] (idempotence)", () => {
    const buffered: readonly BufferedIntent[] = [
      { intent: makeIntent(1), ts: 1000 },
      { intent: makeIntent(2), ts: 1000 },
      { intent: makeIntent(3), ts: 1000 },
      { intent: makeIntent(4), ts: 1000 }
    ];

    // lastApplied=2 means we've already applied cSeq 1 and 2 — only 3 and 4 should be returned.
    const toApply = reconcileFlush(buffered, "p-1", 2);
    expect(toApply).toHaveLength(2);
    expect(toApply[0]?.cSeq).toBe(3);
    expect(toApply[1]?.cSeq).toBe(4);
  });

  it("reconcileFlush returns all intents when lastApplied is 0", () => {
    const buffered: readonly BufferedIntent[] = [
      { intent: makeIntent(1), ts: 1000 },
      { intent: makeIntent(2), ts: 1000 }
    ];
    const toApply = reconcileFlush(buffered, "p-1", 0);
    expect(toApply).toHaveLength(2);
  });

  it("reconcileFlush drops all when all cSeq <= lastApplied (already fully applied)", () => {
    const buffered: readonly BufferedIntent[] = [
      { intent: makeIntent(1), ts: 1000 },
      { intent: makeIntent(2), ts: 1000 }
    ];
    const toApply = reconcileFlush(buffered, "p-1", 5);
    expect(toApply).toHaveLength(0);
  });

  it("drainBuffer clears the buffer after draining", () => {
    const state = createSessionState();
    bufferIntent(state, makeIntent(1), 256, 9000);
    bufferIntent(state, makeIntent(2), 256, 9000);
    drainBuffer(state, 1000, 10_000);
    expect(state.recovery.buffer).toHaveLength(0);
  });
});
