/**
 * Integration tests for the intent plugin via `createApp` + the `inMemory` signaling adapter (D13).
 *
 * Composes a minimal stage + 2 controllers (`transport` + `session` + `intent` only — facades not
 * required for the engine test) over `inMemory` (no real `RTCPeerConnection`) and drives by direct
 * `app.intent.*()` calls. All tests live inside the plugin directory, never in root `tests/`.
 *
 * @file
 * @see ../../index
 */
import { describe, it } from "vitest";

describe("intent — end-to-end over inMemory", () => {
  it.todo(
    "controller intent('move', …) → host onIntent fires with validated payload + correct peerId/cSeq"
  );
  it.todo("preserves ordering across a burst of intents");
});

describe("intent — idempotent reconcile (D4)", () => {
  it.todo("setBuffering(true), fire N intents, drainBuffer(), replay into host receive path twice");
  it.todo(
    "each cSeq applies exactly once (lastApplied de-dups the replay); handler runs N times, not 2N"
  );
});

describe("intent — cap/age loss", () => {
  it.todo("overflowing bufferCap FIFO-drops the oldest buffered intents");
  it.todo("advancing fake time past bufferMaxAgeMs prunes stale entries (vi.useFakeTimers)");
});
