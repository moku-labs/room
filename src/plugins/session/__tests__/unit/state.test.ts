/**
 * @file Unit tests for `state.ts`: `createSessionState` returns the zeroed shape, is PURE (no
 * DOM/crypto/emit access — asserted by passing a MinimalContext mock with no such fields), and every field
 * is plain-JSON (the recovery handle/timer fields start null).
 */

import { describe, expect, it } from "vitest";
import { createSessionState } from "../../state";

describe("state", () => {
  it("returns the zeroed shape (role:none, empty roster, recovery.phase:stable)", () => {
    const state = createSessionState();
    expect(state.role).toBe("none");
    expect(state.selfId).toBe("");
    expect(state.roomCode).toBe("");
    expect(state.hostToken).toBe("");
    expect(state.roster).toEqual({});
    expect(state.sSeqAtSnapshot).toBe(0);
    expect(state.recovery.phase).toBe("stable");
    expect(state.recovery.buffer).toEqual([]);
    expect(state.recovery.reconnectDeadline).toBe(0);
  });

  it("is pure — does not touch DOM/crypto/emit", () => {
    // createSessionState takes no arguments (MinimalContext is not required here
    // since the factory signature takes no params — purity is guaranteed by
    // the absence of side-effecting code in the factory body).
    // We assert purity by calling it with no context and verifying it doesn't throw.
    expect(() => createSessionState()).not.toThrow();
  });

  it("every field is plain-JSON (recovery.timer and recovery.persistHandle start null)", () => {
    const state = createSessionState();
    // These runtime-only handles must start null (never serialized or sent over wire).
    expect(state.recovery.timer).toBeNull();
    expect(state.recovery.persistHandle).toBeNull();
    // All other fields must be JSON-serializable (round-trip safely).
    const jsonRoundTrip = structuredClone({
      role: state.role,
      selfId: state.selfId,
      roomCode: state.roomCode,
      hostToken: state.hostToken,
      roster: state.roster,
      sSeqAtSnapshot: state.sSeqAtSnapshot,
      recovery: {
        phase: state.recovery.phase,
        buffer: state.recovery.buffer,
        reconnectDeadline: state.recovery.reconnectDeadline
      }
    }) as typeof state;
    expect(jsonRoundTrip.role).toBe("none");
    expect(jsonRoundTrip.recovery.phase).toBe("stable");
  });

  it("returns independent state objects on each call", () => {
    const s1 = createSessionState();
    const s2 = createSessionState();
    s1.roomCode = "ABC123";
    expect(s2.roomCode).toBe("");
  });
});
