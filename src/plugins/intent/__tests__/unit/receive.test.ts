/**
 * Unit tests for `attachIntentReceive` against a mock context.
 *
 * Fake `Wire` that captures the `on` handler; driven directly with the per-app `state` — no API instance
 * and no module-level singleton (D14): a second app's `state` yields an independent registration over its
 * own state.
 *
 * @file
 * @see ../../receive
 */
import { describe, it } from "vitest";

describe("attachIntentReceive", () => {
  it.todo("registers exactly one Wire.on handler");
  it.todo("filters to frame.t === 'intent' and ignores other frame tags");
  it.todo("routes into ctx.state: validate → de-dup vs lastApplied → dispatch to registry handler");
  it.todo("a second app's ctx yields an independent registration over its own ctx.state");
});
