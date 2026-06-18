/**
 * Unit tests for the pure intent validator.
 *
 * The heart of the suite: exhaustive table-driven cases for `validateIntent` — each `IntentFieldRule`
 * type, missing/unknown fields, and non-object payloads. Pure function, no kernel, no mocks.
 *
 * @file
 * @see ../../validate
 */
import { describe, expect, it } from "vitest";
import type { IntentSchema } from "../../types";
import { validateIntent } from "../../validate";

// ---------------------------------------------------------------------------
// Shared schemas used across multiple tests
// ---------------------------------------------------------------------------

const numberSchema: IntentSchema = {
  fields: { val: { type: "number", min: -1, max: 1 } },
  additionalFields: false
};

const stringSchema: IntentSchema = {
  fields: { tag: { type: "string", maxLength: 5 } },
  additionalFields: false
};

const boolSchema: IntentSchema = {
  fields: { active: { type: "boolean" } },
  additionalFields: false
};

const enumSchema: IntentSchema = {
  fields: { dir: { type: "enum", values: ["up", "down", "left", "right"] } },
  additionalFields: false
};

const moveSchema: IntentSchema = {
  fields: {
    dx: { type: "number", min: -1, max: 1 },
    dy: { type: "number", min: -1, max: 1 },
    boost: { type: "boolean" }
  },
  additionalFields: false
};

describe("validateIntent", () => {
  it("number rule: passes within inclusive [min, max] bounds", () => {
    expect(validateIntent(numberSchema, { val: 0 })).toBe(true);
    expect(validateIntent(numberSchema, { val: -1 })).toBe(true); // inclusive min
    expect(validateIntent(numberSchema, { val: 1 })).toBe(true); // inclusive max
    expect(validateIntent(numberSchema, { val: 0.5 })).toBe(true);
  });

  it("number rule: rejects below min and above max (inclusive)", () => {
    expect(validateIntent(numberSchema, { val: -1.1 })).toBe(false);
    expect(validateIntent(numberSchema, { val: 1.1 })).toBe(false);
    expect(validateIntent(numberSchema, { val: 2 })).toBe(false);
    expect(validateIntent(numberSchema, { val: -2 })).toBe(false);
  });

  it("number rule: rejects NaN and ±Infinity", () => {
    expect(validateIntent(numberSchema, { val: Number.NaN })).toBe(false);
    expect(validateIntent(numberSchema, { val: Number.POSITIVE_INFINITY })).toBe(false);
    expect(validateIntent(numberSchema, { val: Number.NEGATIVE_INFINITY })).toBe(false);
  });

  it("string rule: passes within maxLength; rejects when longer", () => {
    expect(validateIntent(stringSchema, { tag: "hello" })).toBe(true); // exactly 5
    expect(validateIntent(stringSchema, { tag: "hi" })).toBe(true);
    expect(validateIntent(stringSchema, { tag: "" })).toBe(true);
    expect(validateIntent(stringSchema, { tag: "toolong" })).toBe(false); // 7 chars > 5
  });

  it("boolean rule: passes true/false; rejects non-boolean", () => {
    expect(validateIntent(boolSchema, { active: true })).toBe(true);
    expect(validateIntent(boolSchema, { active: false })).toBe(true);
    expect(validateIntent(boolSchema, { active: 1 })).toBe(false);
    expect(validateIntent(boolSchema, { active: "true" })).toBe(false);
    expect(validateIntent(boolSchema, { active: 0 })).toBe(false);
  });

  it("enum rule: passes a === member; rejects a non-member", () => {
    expect(validateIntent(enumSchema, { dir: "up" })).toBe(true);
    expect(validateIntent(enumSchema, { dir: "down" })).toBe(true);
    expect(validateIntent(enumSchema, { dir: "left" })).toBe(true);
    expect(validateIntent(enumSchema, { dir: "right" })).toBe(true);
    expect(validateIntent(enumSchema, { dir: "diagonal" })).toBe(false);
    expect(validateIntent(enumSchema, { dir: "UP" })).toBe(false); // case-sensitive
    expect(validateIntent(enumSchema, { dir: 42 })).toBe(false);
  });

  it("rejects when a required field is missing", () => {
    expect(validateIntent(moveSchema, { dx: 0.1, boost: true })).toBe(false); // missing dy
    expect(validateIntent(moveSchema, { dy: 0.1, boost: true })).toBe(false); // missing dx
    expect(validateIntent(moveSchema, { dx: 0.1, dy: 0.2 })).toBe(false); // missing boost
    expect(validateIntent(moveSchema, {})).toBe(false);
  });

  it("additionalFields:false rejects an unknown field", () => {
    expect(validateIntent(moveSchema, { dx: 0, dy: 0, boost: true, hax: 1 })).toBe(false);
    expect(validateIntent(numberSchema, { val: 0, extra: "oops" })).toBe(false);
  });

  it("additionalFields:true tolerates an extra ignored field", () => {
    const openSchema: IntentSchema = {
      fields: { val: { type: "number" } },
      additionalFields: true
    };
    expect(validateIntent(openSchema, { val: 5, bonus: "extra" })).toBe(true);
    expect(validateIntent(openSchema, { val: 5 })).toBe(true);
  });

  it("rejects a non-object payload (null, array, scalar)", () => {
    expect(validateIntent(numberSchema, null)).toBe(false);
    expect(validateIntent(numberSchema, [1, 2, 3])).toBe(false);
    expect(validateIntent(numberSchema, 42)).toBe(false);
    expect(validateIntent(numberSchema, "hello")).toBe(false);
    expect(validateIntent(numberSchema, true)).toBe(false);
    expect(validateIntent(numberSchema, undefined)).toBe(false);
  });
});
