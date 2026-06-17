/**
 * Type-level tests for the intent plugin's public surface.
 *
 * Verify `intent` payload is `JsonValue`-only, `require(syncPlugin)` is a type error (no `sync`
 * dependency — D5), no `room:*` is emittable from `intent` (it declares none), and `IntentFieldRule`
 * union exhaustiveness. Uses `expectTypeOf` / `@ts-expect-error`.
 *
 * @file
 * @see ../../types
 */
import { describe, it } from "vitest";

describe("intent type surface", () => {
  it.todo("IntentApi['intent'] accepts (string, JsonValue)");
  it.todo("passing a non-JsonValue (Map / function) to intent is a @ts-expect-error");
  it.todo("ctx.require(transportPlugin) is the Wire-bearing transport API");
  it.todo("ctx.require(syncPlugin) is a @ts-expect-error (intent does not depend on sync, D5)");
  it.todo("no room:* event is emittable from inside intent (declares none, depends on no owner)");
  it.todo("an IntentFieldRule with an unknown type is a @ts-expect-error");
});
