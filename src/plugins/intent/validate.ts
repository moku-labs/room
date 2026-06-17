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
import type { IntentSchema } from "./types";

/**
 * Correctness-only shape-check (D6). Returns `true` iff `payload` is a JSON object that satisfies every
 * rule in `schema.fields` and (when `schema.additionalFields` is `false`) carries no extra field. Pure
 * — no I/O, no throw — so it is exhaustively unit-testable in isolation and reusable by the host
 * receive path and by type-level tests.
 *
 * @param schema - The registered shape-check for the intent kind.
 * @param payload - The raw inbound `IntentFrame.payload` (typed `unknown` on the wire).
 * @throws {Error} Always, until implemented (skeleton stub).
 * @example
 * ```ts
 * validateIntent(moveSchema, { dx: 0.2, dy: -0.1, boost: true }); // true
 * validateIntent(moveSchema, { dx: 5 }); // false — dx out of [-1,1], dy missing
 * validateIntent(moveSchema, { dx: 0, dy: 0, hax: 1 }); // false — unknown field, additionalFields:false
 * ```
 */
export function validateIntent(schema: IntentSchema, payload: unknown): boolean {
  throw new Error("not implemented");
}
