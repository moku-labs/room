/**
 * Unit tests for `createIntentApi` against a mock context.
 *
 * A `{ config, state, require, emit }` stub where `require(transportPlugin)` returns a fake `Wire`
 * (a `vi.fn()` `send` + a captured `on` handler) and `require(sessionPlugin)` returns a stub host-id
 * resolver. The SAME mock `ctx.state` is shared by the API and by `attachIntentReceive` in the
 * host-receive cases — proving the per-app `ctx`/`ctx.state` seam (D14) without any module-level instance.
 *
 * @file
 * @see ../../api
 */
import { describe, it } from "vitest";

describe("createIntentApi — controller intent()", () => {
  it.todo("stamps a monotonic cSeq starting at 0 and increments across calls");
  it.todo("builds the correct IntentFrame and calls wire.send(hostId, frame)");
  it.todo("never routes through emit (asserts no emit on the ctx)");
});

describe("createIntentApi — host register() + onIntent()", () => {
  it.todo("a valid IntentFrame invokes the handler with (payload, { peerId, cSeq })");
  it.todo("an unregistered name drops silently (handler not called)");
  it.todo("a schema-failing payload drops silently (handler not called)");
  it.todo("a duplicate (cSeq <= lastApplied[peerId]) drops silently");
  it.todo("lastApplied[peerId] advances only on applied frames; two peers stay independent");
  it.todo("onIntent returns an unsubscribe that detaches the handler");
});

describe("createIntentApi — buffer seam", () => {
  it.todo("setBuffering(true) makes intent() enqueue instead of send");
  it.todo("bufferedCount() reflects the queue size");
  it.todo("drainBuffer() returns ts-ordered entries and empties the buffer");
  it.todo("bufferCap FIFO-drops the oldest entries past the cap");
  it.todo("bufferMaxAgeMs prunes stale entries on enqueue/drain");
});
