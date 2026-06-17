/**
 * @file stage — type-level tests (WARN-2 closure + StageApi surface).
 *
 * Proves the facade's re-declaration actually closes the event-visibility gap (contracts §3.3,
 * spec/14 §7): a game plugin with depends:[stagePlugin] must see ALL five room:* keys on its
 * ctx.emit / hooks surface, and reject unknown keys. Also pins the StageApi method signatures.
 */
import { describe, it } from "vitest";

describe("WARN-2 closure — depends:[stagePlugin] sees all five room:* keys", () => {
  it.todo("all five room:* keys are present and correctly-payloaded on a dependent's ctx.emit");
  it.todo("all five room:* keys are assignable as a dependent's hooks keys");
  it.todo("@ts-expect-error: ctx.emit('nope', {}) on a non-room key is rejected");
});

describe("no-generics guard", () => {
  it.todo("createPlugin('stage', …) carries no explicit generic (R1) — by construction / lint");
});

describe("StageApi surface", () => {
  it.todo("expectTypeOf<App['stage']>() matches StageApi exactly (method names + signatures)");
  it.todo("@ts-expect-error: mutate rejects a non-JsonValue recipe");
  it.todo("@ts-expect-error: onIntent rejects a wrong-arity handler");
});
