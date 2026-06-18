/**
 * The pure correctness-only intent validator (D6).
 *
 * `validateIntent` is the most heavily unit-tested unit in the plugin: no I/O, no throw, no kernel —
 * structural shape-check only (field presence, primitive type, inclusive numeric/length bounds, enum
 * membership). Reused by the host receive path ({@link ./receive}) and by type-level tests.
 *
 * @file
 * @see README.md
 */
import type { IntentFieldRule, IntentSchema } from "./types";

/**
 * Returns `true` iff `value` is a number that satisfies the numeric rule's bounds.
 * NaN and ±Infinity always fail regardless of min/max.
 *
 * @param rule - The number field rule (with optional `min`/`max` inclusive bounds).
 * @param value - The raw field value from the payload.
 * @returns `true` if `value` passes the numeric rule.
 * @example
 * ```ts
 * checkNumber({ type: "number", min: -1, max: 1 }, 0.5);  // true
 * checkNumber({ type: "number", min: -1, max: 1 }, 2);    // false
 * checkNumber({ type: "number" }, NaN);                   // false
 * ```
 */
function checkNumber(rule: Extract<IntentFieldRule, { type: "number" }>, value: unknown): boolean {
  if (typeof value !== "number") return false;
  if (!Number.isFinite(value) || Number.isNaN(value)) return false;
  if (rule.min !== undefined && value < rule.min) return false;
  if (rule.max !== undefined && value > rule.max) return false;
  return true;
}

/**
 * Returns `true` iff `value` is a string satisfying the string rule's optional `maxLength`.
 *
 * @param rule - The string field rule (with optional `maxLength` cap).
 * @param value - The raw field value from the payload.
 * @returns `true` if `value` passes the string rule.
 * @example
 * ```ts
 * checkString({ type: "string", maxLength: 5 }, "hello");   // true
 * checkString({ type: "string", maxLength: 5 }, "toolong");  // false
 * ```
 */
function checkString(rule: Extract<IntentFieldRule, { type: "string" }>, value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (rule.maxLength !== undefined && value.length > rule.maxLength) return false;
  return true;
}

/**
 * Checks a single value against one {@link IntentFieldRule}. Returns `true` if the value satisfies
 * the rule; `false` to drop the containing frame. Pure — no I/O, no throw.
 *
 * @param rule - The field rule to check against.
 * @param value - The raw field value from the payload object.
 * @returns `true` if the value satisfies the rule.
 * @example
 * ```ts
 * checkFieldRule({ type: "boolean" }, true);   // true
 * checkFieldRule({ type: "boolean" }, 1);      // false
 * ```
 */
function checkFieldRule(rule: IntentFieldRule, value: unknown): boolean {
  if (rule.type === "number") return checkNumber(rule, value);
  if (rule.type === "string") return checkString(rule, value);
  if (rule.type === "boolean") return typeof value === "boolean";
  // rule.type === "enum"
  return rule.values.includes(value as string | number | boolean);
}

/**
 * Correctness-only shape-check (D6). Returns `true` iff `payload` is a JSON object that satisfies every
 * rule in `schema.fields` and (when `schema.additionalFields` is `false`) carries no extra field. Pure
 * — no I/O, no throw — so it is exhaustively unit-testable in isolation and reusable by the host
 * receive path and by type-level tests.
 *
 * @param schema - The registered shape-check for the intent kind.
 * @param payload - The raw inbound `IntentFrame.payload` (typed `unknown` on the wire).
 * @returns `true` if the payload passes the shape-check; `false` to drop the frame.
 * @example
 * ```ts
 * validateIntent(moveSchema, { dx: 0.2, dy: -0.1, boost: true }); // true
 * validateIntent(moveSchema, { dx: 5 }); // false — dx out of [-1,1], dy missing
 * validateIntent(moveSchema, { dx: 0, dy: 0, hax: 1 }); // false — unknown field, additionalFields:false
 * ```
 */
export function validateIntent(schema: IntentSchema, payload: unknown): boolean {
  // Non-object payloads (null, array, scalar) always fail
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }

  const object = payload as Record<string, unknown>;

  // Check every required field is present and passes its rule
  for (const [fieldName, rule] of Object.entries(schema.fields)) {
    if (!(fieldName in object)) return false;
    if (!checkFieldRule(rule, object[fieldName])) return false;
  }

  // When additionalFields is false, reject any key not listed in fields
  if (!schema.additionalFields) {
    for (const key of Object.keys(object)) {
      if (!(key in schema.fields)) return false;
    }
  }

  return true;
}
