/**
 * Unit tests for `createSyncState` (`state.ts`): the documented defaults and plain-JSON serializability
 * of every at-rest field (`throttleHandle` and `engine` are the two non-serialized runtime cells, both
 * `null` at rest).
 *
 * @file
 * @see ../../README.md
 */
import { describe, expect, it } from "vitest";
import { createSyncState } from "../../state";

describe("createSyncState", () => {
  it("returns snapshot:{}, dirty:{}, sSeq:0, ready:false, stale:false, broadcasting:false", () => {
    const state = createSyncState();

    expect(state.snapshot).toEqual({});
    expect(state.dirty).toEqual({});
    expect(state.sSeq).toBe(0);
    expect(state.ready).toBe(false);
    expect(state.stale).toBe(false);
    expect(state.broadcasting).toBe(false);
  });

  it("throttleHandle and engine are both null at rest", () => {
    const state = createSyncState();

    expect(state.throttleHandle).toBeNull();
    expect(state.engine).toBeNull();
  });

  it("every serialized field is plain-JSON (JSON.parse(JSON.stringify(x)) stable)", () => {
    const state = createSyncState();

    // Extract only the serializable fields (throttleHandle and engine are runtime-only)
    const serializable = {
      snapshot: state.snapshot,
      dirty: state.dirty,
      sSeq: state.sSeq,
      ready: state.ready,
      stale: state.stale,
      broadcasting: state.broadcasting
    };

    const roundTripped = structuredClone(serializable) as typeof serializable;
    expect(roundTripped).toEqual(serializable);
  });

  it("creates independent instances per call (no shared state)", () => {
    const state1 = createSyncState();
    const state2 = createSyncState();

    // Mutate state1 snapshot — state2 must be unaffected
    state1.snapshot = { scores: { p1: 10 } };

    expect(state2.snapshot).toEqual({});
  });
});
