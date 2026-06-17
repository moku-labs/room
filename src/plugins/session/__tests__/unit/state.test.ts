/**
 * @file Unit tests for `state.ts`: `createSessionState` returns the zeroed shape, is PURE (no
 * DOM/crypto/emit access — asserted by passing a MinimalContext mock with no such fields), and every field
 * is plain-JSON (the recovery handle/timer fields start null).
 */

import { describe, it } from "vitest";

describe("state", () => {
  it.todo("returns the zeroed shape (role:none, empty roster, recovery.phase:stable)");
  it.todo("is pure — does not touch DOM/crypto/emit");
  it.todo("every field is plain-JSON (recovery.timer and recovery.persistHandle start null)");
});
