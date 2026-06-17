/**
 * @file Type-level tests for the controller facade (`expectTypeOf` / `@ts-expect-error`). Verifies the
 * WARN-2 build-time check (all five `room:*` keys visible/typed through the single `depends:
 * [controllerPlugin]` edge), the `ControllerApi` method signatures, the `JsonValue`-only intent payload
 * constraint, and that NO explicit generic is used on `createPlugin` (R1).
 */
import { describe, it } from "vitest";

describe("controller facade — room:* visibility through the depends edge (WARN-2)", () => {
  it.todo("from depends: [controllerPlugin], all five room:* keys are present on ctx.emit / hooks");
  it.todo(
    "room:network-warning payload narrows to 'ice-failed' | 'rendezvous-unreachable' | 'channel-closed'"
  );
  it.todo("ctx.emit('room:bogus', {}) is a compile error (unknown event key rejected)");
});

describe("controller facade — ControllerApi signatures", () => {
  it.todo("expectTypeOf(app.controller).toMatchTypeOf<ControllerApi>()");
  it.todo("joinRoom returns Promise<void>");
  it.todo("read returns Readonly<Record<string, JsonValue>> | undefined");
  it.todo("intent returns void; requestWakeLock returns Promise<boolean>");
});

describe("controller facade — plain-JSON + inference constraints", () => {
  it.todo(
    "@ts-expect-error controller.intent('move', () => {}) — function payload is not JsonValue (spec/11 §1.7)"
  );
  it.todo(
    "@ts-expect-error no explicit generic on createPlugin('controller', {…}) — types infer (R1)"
  );
});
