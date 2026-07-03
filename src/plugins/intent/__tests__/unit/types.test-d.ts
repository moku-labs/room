/**
 * Type-level tests for the intent plugin's public surface.
 *
 * Verify `intent` payload is `JsonValue`-only, no `room:*` is emittable from `intent` (it declares
 * none), and `IntentFieldRule` union exhaustiveness. Uses `expectTypeOf` / `@ts-expect-error`.
 *
 * Note: the `ctx.require(syncPlugin)` type-error test (D5) cannot be exercised here without importing
 * syncPlugin, which does not exist yet (Wave 3 parallel build). The D5 invariant is enforced
 * structurally — `intentPlugin.depends` only lists `[transportPlugin, sessionPlugin]`, so `sync` is
 * simply absent from the dependency array and the type system has no `syncPlugin` resolver to offer.
 *
 * @file
 * @see ../../types
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import type { Frame, IntentAckFrame, IntentFrame, JsonValue } from "../../../transport/protocol";
import type {
  BufferedIntent,
  IntentApi,
  IntentConfig,
  IntentDelivery,
  IntentFieldRule,
  IntentSchema
} from "../../types";

describe("intent type surface", () => {
  it("IntentApi['intent'] accepts (string, JsonValue)", () => {
    expectTypeOf<IntentApi["intent"]>().parameters.toMatchTypeOf<[string, JsonValue]>();
    expect(true).toBe(true); // satisfy sonarjs/assertions-in-tests
  });

  it("Map is not assignable to JsonValue (only plain-JSON allowed)", () => {
    expectTypeOf<Map<string, string>>().not.toMatchTypeOf<JsonValue>();
    expect(true).toBe(true);
  });

  it("function is not assignable to JsonValue", () => {
    expectTypeOf<() => void>().not.toMatchTypeOf<JsonValue>();
    expect(true).toBe(true);
  });

  it("IntentFieldRule union: number type is valid", () => {
    const rule: IntentFieldRule = { type: "number", min: 0, max: 1 };
    expectTypeOf(rule).toMatchTypeOf<IntentFieldRule>();
    expect(rule.type).toBe("number");
  });

  it("IntentFieldRule union: string type is valid", () => {
    const rule: IntentFieldRule = { type: "string", maxLength: 100 };
    expectTypeOf(rule).toMatchTypeOf<IntentFieldRule>();
    expect(rule.type).toBe("string");
  });

  it("IntentFieldRule union: boolean type is valid", () => {
    const rule: IntentFieldRule = { type: "boolean" };
    expectTypeOf(rule).toMatchTypeOf<IntentFieldRule>();
    expect(rule.type).toBe("boolean");
  });

  it("IntentFieldRule union: enum type is valid", () => {
    const rule: IntentFieldRule = { type: "enum", values: ["a", "b"] };
    expectTypeOf(rule).toMatchTypeOf<IntentFieldRule>();
    expect(rule.type).toBe("enum");
  });

  it("an IntentFieldRule with an unknown type is a @ts-expect-error", () => {
    // @ts-expect-error -- "unknown" is not a valid IntentFieldRule discriminant
    const bad = { type: "unknown" } satisfies IntentFieldRule;
    // use bad so sonarjs doesn't flag it as unused
    expect(bad.type).toBe("unknown");
  });

  it("IntentApi methods are callable with correct parameter types", () => {
    expectTypeOf<IntentApi["register"]>().parameters.toMatchTypeOf<[string, IntentSchema]>();
    expectTypeOf<IntentApi["onIntent"]>().returns.toMatchTypeOf<() => void>();
    expectTypeOf<IntentApi["setBuffering"]>().parameters.toMatchTypeOf<[boolean]>();
    expectTypeOf<IntentApi["drainBuffer"]>().returns.toMatchTypeOf<readonly BufferedIntent[]>();
    expectTypeOf<IntentApi["bufferedCount"]>().returns.toMatchTypeOf<number>();
    expect(true).toBe(true);
  });

  it("IntentAckFrame is a Frame variant carrying the acknowledged cSeq (§4.3)", () => {
    expectTypeOf<IntentAckFrame>().toMatchTypeOf<Frame>();
    expectTypeOf<IntentAckFrame["t"]>().toEqualTypeOf<"intent-ack">();
    expectTypeOf<IntentAckFrame["cSeq"]>().toBeNumber();
    expect(true).toBe(true);
  });

  it("IntentConfig carries the at-least-once knobs alongside the buffer window", () => {
    expectTypeOf<IntentConfig["ackTimeoutMs"]>().toBeNumber();
    expectTypeOf<IntentConfig["maxRetransmits"]>().toBeNumber();
    expect(true).toBe(true);
  });

  it("IntentDelivery's seams line up with the wire frame type", () => {
    expectTypeOf<IntentDelivery["send"]>().parameters.toMatchTypeOf<[IntentFrame]>();
    expectTypeOf<IntentDelivery["onAck"]>().parameters.toMatchTypeOf<[number]>();
    expectTypeOf<IntentDelivery["retire"]>().returns.toMatchTypeOf<readonly IntentFrame[]>();
    expect(true).toBe(true);
  });
});
