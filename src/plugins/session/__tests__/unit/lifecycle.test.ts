/**
 * @file Unit tests for `lifecycle/code.ts` + `lifecycle/roster.ts`: room-code generation (6 chars,
 * confusable-free alphabet, seeded RNG), join-URL composition (with/without `joinUrlBase`), roster
 * upsert/cap enforcement (9th rejected), star-topology rejection, sorted defensive-copy read.
 */

import { describe, it } from "vitest";

describe("lifecycle/code: room code", () => {
  it.todo("generates ROOM_CODE_LENGTH (6) characters");
  it.todo("draws only from the confusable-free alphabet (excludes 0/O, 1/I/L)");
  it.todo("uses crypto.getRandomValues (deterministic under a seeded RNG injection)");
});

describe("lifecycle/qr: join URL", () => {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: test label quotes the literal join-URL template shape
  it.todo("composes ${joinUrlBase}?room=CODE when joinUrlBase is set");
  it.todo("falls back to location.origin when joinUrlBase is empty");
});

describe("lifecycle/roster", () => {
  it.todo("upserts a RosterEntry");
  it.todo("rejects the 9th controller, capping at maxControllers");
  it.todo("removes a roster entry idempotently");
  it.todo("readRoster returns a defensive copy sorted by joinedAt ascending");
  it.todo("isStarViolation rejects a controller<->controller channel attempt");
});
