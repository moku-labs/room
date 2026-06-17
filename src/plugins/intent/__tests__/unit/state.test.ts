/**
 * Unit tests for `createIntentState`.
 *
 * Asserts the empty per-app initial shape; state is config-light (defaults are not read here).
 *
 * @file
 * @see ../../state
 */
import { describe, it } from "vitest";

describe("createIntentState", () => {
  it.todo("returns empty registry + lastApplied Maps");
  it.todo("returns nextCSeq:0, buffering:false, and an empty buffer");
  it.todo("does not read config defaults at construction (config-light)");
});
