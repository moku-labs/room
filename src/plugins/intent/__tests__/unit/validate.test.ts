/**
 * Unit tests for the pure intent validator.
 *
 * The heart of the suite: exhaustive table-driven cases for `validateIntent` — each `IntentFieldRule`
 * type, missing/unknown fields, and non-object payloads. Pure function, no kernel, no mocks.
 *
 * @file
 * @see ../../validate
 */
import { describe, it } from "vitest";

describe("validateIntent", () => {
  it.todo("number rule: passes within inclusive [min, max] bounds");
  it.todo("number rule: rejects below min and above max (inclusive)");
  it.todo("number rule: rejects NaN and ±Infinity");
  it.todo("string rule: passes within maxLength; rejects when longer");
  it.todo("boolean rule: passes true/false; rejects non-boolean");
  it.todo("enum rule: passes a === member; rejects a non-member");
  it.todo("rejects when a required field is missing");
  it.todo("additionalFields:false rejects an unknown field");
  it.todo("additionalFields:true tolerates an extra ignored field");
  it.todo("rejects a non-object payload (null, array, scalar)");
});
