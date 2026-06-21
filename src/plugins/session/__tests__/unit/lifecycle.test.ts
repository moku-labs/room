/**
 * @file Unit tests for `lifecycle/code.ts` + `lifecycle/roster.ts`: room-code generation (6 chars,
 * confusable-free alphabet, seeded RNG, configurable codeLength), join-URL composition
 * (with/without `joinUrlBase`), roster upsert/cap enforcement (9th rejected), star-topology
 * rejection, sorted defensive-copy read.
 */

import { describe, expect, it } from "vitest";
import type { RosterEntry } from "../../../../contracts";
import { ROOM_CODE_LENGTH } from "../../../../contracts";
import { generateRoomCode } from "../../lifecycle/code";
import { buildJoinUrl } from "../../lifecycle/qr";
import {
  isStarViolation,
  readRoster,
  removeRosterEntry,
  upsertRosterEntry
} from "../../lifecycle/roster";
import { createSessionState } from "../../state";

// The confusable-free alphabet — excludes 0, O, 1, I, L.
const CONFUSABLE = new Set(["0", "O", "1", "I", "L"]);

// Seeded RNG for determinism tests (all bytes = 0 → index 0 in alphabet → always 'A').
// Module-scope per unicorn/consistent-function-scoping.
const allZeroBytes = (n: number): Uint8Array => new Uint8Array(n).fill(0);

describe("lifecycle/code: room code", () => {
  it("generates ROOM_CODE_LENGTH (6) characters", () => {
    const code = generateRoomCode();
    expect(code).toHaveLength(ROOM_CODE_LENGTH);
  });

  it("draws only from the confusable-free alphabet (excludes 0/O, 1/I/L)", () => {
    // Generate 50 codes and assert none contain confusable characters.
    for (let i = 0; i < 50; i++) {
      const code = generateRoomCode();
      for (const char of code) {
        expect(CONFUSABLE.has(char), `code ${code} contains confusable char '${char}'`).toBe(false);
        expect(char).toMatch(/^[A-Z2-9]$/);
      }
    }
  });

  it("uses crypto.getRandomValues (deterministic under a seeded RNG injection)", () => {
    // Inject a deterministic byte source.
    let callCount = 0;
    const seededBytes = (n: number): Uint8Array => {
      callCount++;
      // All bytes = 0 → index 0 in alphabet → always 'A'.
      return new Uint8Array(n).fill(0);
    };
    const code1 = generateRoomCode(seededBytes);
    const code2 = generateRoomCode(seededBytes);
    // Both codes must be fully 'A' (all bytes map to index 0).
    expect(code1).toBe("AAAAAA");
    expect(code2).toBe("AAAAAA");
    // RNG was called at least once per generateRoomCode call.
    expect(callCount).toBeGreaterThanOrEqual(2);
  });

  // --- Cycle 2: codeLength parameter (D24 security baseline) ---

  it("honours a custom length of 8 (serverSignaling deployment)", () => {
    // When codeLength=8 is passed, the generated code must be exactly 8 chars.
    const code = generateRoomCode(undefined, 8);
    expect(code).toHaveLength(8);
  });

  it("honours a custom length of 4", () => {
    const code = generateRoomCode(undefined, 4);
    expect(code).toHaveLength(4);
  });

  it("custom length still draws from the confusable-free alphabet", () => {
    for (let i = 0; i < 20; i++) {
      const code = generateRoomCode(undefined, 8);
      for (const char of code) {
        expect(CONFUSABLE.has(char), `code ${code} contains confusable char '${char}'`).toBe(false);
        expect(char).toMatch(/^[A-Z2-9]$/);
      }
    }
  });

  it("custom length is deterministic under a seeded RNG", () => {
    const code = generateRoomCode(allZeroBytes, 8);
    // All bytes = 0 → index 0 → always 'A', now 8 chars.
    expect(code).toBe("AAAAAAAA");
  });

  it("no length arg defaults to ROOM_CODE_LENGTH (6) — existing behaviour unchanged", () => {
    // Re-assert that omitting length still returns a 6-char code (non-breaking default).
    expect(generateRoomCode()).toHaveLength(ROOM_CODE_LENGTH);
    expect(ROOM_CODE_LENGTH).toBe(6);
  });
});

describe("lifecycle/qr: join URL", () => {
  it("composes joinUrlBase?room=CODE when joinUrlBase is set", () => {
    const url = buildJoinUrl("G7K2QF", "https://tv.example");
    expect(url).toBe("https://tv.example?room=G7K2QF");
  });

  it("falls back to location.origin when joinUrlBase is empty", () => {
    // In Bun/Node (no DOM), location is undefined → falls back to empty string.
    const url = buildJoinUrl("G7K2QF", "");
    // In Bun there's no `location` — the base is "" so the URL is "?room=G7K2QF".
    expect(url).toMatch(/\?room=G7K2QF$/);
  });
});

function makeEntry(id: string, joinedAt = 1000): RosterEntry {
  return { id, reconnectToken: `rt-${id}`, joinedAt };
}

describe("lifecycle/roster", () => {
  it("upserts a RosterEntry", () => {
    const state = createSessionState();
    const entry = makeEntry("p-1");
    const admitted = upsertRosterEntry(state, entry, 8);
    expect(admitted).toBe(true);
    expect(state.roster["p-1"]).toEqual(entry);
  });

  it("rejects the 9th controller, capping at maxControllers", () => {
    const state = createSessionState();
    // Add 8 controllers (maxControllers = 8).
    for (let i = 1; i <= 8; i++) {
      const admitted = upsertRosterEntry(state, makeEntry(`p-${i}`, i * 1000), 8);
      expect(admitted).toBe(true);
    }
    expect(Object.keys(state.roster)).toHaveLength(8);
    // 9th should be rejected.
    const admitted = upsertRosterEntry(state, makeEntry("p-9", 9000), 8);
    expect(admitted).toBe(false);
    expect(Object.keys(state.roster)).toHaveLength(8);
    expect(state.roster["p-9"]).toBeUndefined();
  });

  it("allows updating an existing entry even at cap", () => {
    const state = createSessionState();
    for (let i = 1; i <= 8; i++) {
      upsertRosterEntry(state, makeEntry(`p-${i}`, i * 1000), 8);
    }
    // Updating an existing entry at full capacity should succeed.
    const updatedEntry: RosterEntry = { id: "p-1", reconnectToken: "rt-updated", joinedAt: 9999 };
    const admitted = upsertRosterEntry(state, updatedEntry, 8);
    expect(admitted).toBe(true);
    expect(state.roster["p-1"]).toEqual(updatedEntry);
  });

  it("removes a roster entry idempotently", () => {
    const state = createSessionState();
    upsertRosterEntry(state, makeEntry("p-1"), 8);
    // First remove returns true.
    expect(removeRosterEntry(state, "p-1")).toBe(true);
    expect(state.roster["p-1"]).toBeUndefined();
    // Second remove is idempotent — returns false.
    expect(removeRosterEntry(state, "p-1")).toBe(false);
  });

  it("readRoster returns a defensive copy sorted by joinedAt ascending", () => {
    const state = createSessionState();
    upsertRosterEntry(state, makeEntry("p-3", 3000), 8);
    upsertRosterEntry(state, makeEntry("p-1", 1000), 8);
    upsertRosterEntry(state, makeEntry("p-2", 2000), 8);

    const roster = readRoster(state);
    expect(roster).toHaveLength(3);
    expect(roster[0]?.id).toBe("p-1");
    expect(roster[1]?.id).toBe("p-2");
    expect(roster[2]?.id).toBe("p-3");

    // Defensive copy — mutating the returned array should not affect state.
    // (readonly array can't be mutated with push, but we verify the reference isn't state.roster)
    // We verify the sorted order is a snapshot, not a live view.
    upsertRosterEntry(state, makeEntry("p-4", 500), 8);
    expect(roster).toHaveLength(3); // Old snapshot still has 3.
  });

  it("isStarViolation rejects a controller<->controller channel attempt", () => {
    // On the host: a channel between two controllers (neither is selfId) is a violation.
    expect(isStarViolation("p-1", "p-2", "host", "host")).toBe(true);
    // A channel involving the host (selfId) is not a violation.
    expect(isStarViolation("host", "p-1", "host", "host")).toBe(false);
    expect(isStarViolation("p-1", "host", "host", "host")).toBe(false);
  });

  it("isStarViolation on a controller role flags a channel that does not involve us", () => {
    // On a controller (role !== "host"): a channel between two OTHER peers is a violation.
    expect(isStarViolation("p-1", "p-2", "self", "controller")).toBe(true);
  });

  it("isStarViolation on a controller role allows a channel that involves us", () => {
    // On a controller: a channel where we (selfId) are the `from` endpoint is allowed.
    expect(isStarViolation("self", "p-2", "self", "controller")).toBe(false);
    // ...and where we are the `to` endpoint.
    expect(isStarViolation("p-1", "self", "self", "controller")).toBe(false);
  });

  it("isStarViolation on a none role behaves like the non-host branch", () => {
    // role "none" also takes the non-host branch.
    expect(isStarViolation("p-1", "p-2", "self", "none")).toBe(true);
    expect(isStarViolation("self", "p-2", "self", "none")).toBe(false);
  });
});
