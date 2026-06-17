/**
 * @file Unit tests for `recovery/buffer.ts`: controller buffers IntentFrames with timestamps while
 * phase !== "stable"; ring-buffer cap (intentBufferMax) drops oldest; entries older than
 * intentBufferMaxAgeMs are discarded on flush; flush payload is cSeq-ordered; host-side reconcile drops
 * cSeq <= lastApplied[peerId] (idempotence, §4.3).
 */

import { describe, it } from "vitest";

describe("recovery/buffer", () => {
  it.todo("buffers IntentFrames with capture timestamps while phase !== stable");
  it.todo("drops the oldest entry when the ring cap (intentBufferMax) is exceeded");
  it.todo("discards entries older than intentBufferMaxAgeMs on flush");
  it.todo("produces a cSeq-ordered flush payload");
  it.todo("host reconcile drops cSeq <= lastApplied[peerId] (idempotence)");
});
