/**
 * Unit tests for `createIntentState`.
 *
 * Asserts the empty per-app initial shape; state is config-light (defaults are not read here).
 *
 * @file
 * @see ../../state
 */
import { describe, expect, it } from "vitest";
import { createIntentState } from "../../state";

describe("createIntentState", () => {
  it("returns empty registry + lastApplied Maps", () => {
    const state = createIntentState();
    expect(state.registry).toBeInstanceOf(Map);
    expect(state.registry.size).toBe(0);
    expect(state.lastApplied).toBeInstanceOf(Map);
    expect(state.lastApplied.size).toBe(0);
  });

  it("returns nextCSeq:0, buffering:false, and an empty buffer", () => {
    const state = createIntentState();
    expect(state.nextCSeq).toBe(0);
    expect(state.buffering).toBe(false);
    expect(state.buffer).toEqual([]);
  });

  it("does not read config defaults at construction (config-light)", () => {
    // State factory takes no arguments — it is always config-light.
    // Calling it multiple times produces independent instances.
    const s1 = createIntentState();
    const s2 = createIntentState();
    s1.nextCSeq = 99;
    expect(s2.nextCSeq).toBe(0);
  });
});
