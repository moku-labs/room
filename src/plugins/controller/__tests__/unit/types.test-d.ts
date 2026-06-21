/**
 * @file Type-level tests for the controller facade (`expectTypeOf` / `@ts-expect-error`). Verifies the
 * WARN-2 build-time check (all five `room:*` keys visible/typed through the single
 * `depends: [controllerPlugin]` edge), the `ControllerApi` method signatures, the `JsonValue`-only
 * intent payload constraint, and that NO explicit generic is used on `createPlugin` (R1). Validated
 * by `bunx tsc --noEmit` — this file is EXCLUDED from vitest `include` (`.test-d.ts` convention).
 */
import { createPlugin } from "@moku-labs/web";
import { expectTypeOf } from "vitest";
import type { JsonValue } from "../../../../contracts";
import { controllerPlugin } from "../../index";
import type { ControllerApi } from "../../types";

// ---------------------------------------------------------------------------
// Pin ControllerApi method signatures
// ---------------------------------------------------------------------------

expectTypeOf<ControllerApi["joinRoom"]>().toMatchTypeOf<(code: string) => Promise<void>>();
expectTypeOf<ControllerApi["read"]>().toMatchTypeOf<
  (ns: string) => Readonly<Record<string, JsonValue>> | undefined
>();
expectTypeOf<ControllerApi["on"]>().toMatchTypeOf<
  (ns: string, cb: (value: Readonly<Record<string, JsonValue>>) => void) => () => void
>();
expectTypeOf<ControllerApi["intent"]>().toMatchTypeOf<(name: string, payload: JsonValue) => void>();
expectTypeOf<ControllerApi["requestWakeLock"]>().toMatchTypeOf<() => Promise<boolean>>();
expectTypeOf<ControllerApi["releaseWakeLock"]>().toMatchTypeOf<() => Promise<void>>();

// ---------------------------------------------------------------------------
// room:* visibility through depends:[controllerPlugin] (WARN-2 build-time check)
// ---------------------------------------------------------------------------

// Composing a game plugin against controllerPlugin exposes all five room:* keys
const padGame = createPlugin("padGame", {
  depends: [controllerPlugin],
  hooks: () => ({
    // All five room:* hooks are reachable — WARN-2 closed at the type level
    "room:peer-joined": (p: { peerId: string }) => {
      expectTypeOf(p).toMatchTypeOf<{ peerId: string }>();
    },
    "room:peer-left": (p: { peerId: string }) => {
      expectTypeOf(p).toMatchTypeOf<{ peerId: string }>();
    },
    "room:host-reconnecting": (p: Record<string, never>) => {
      expectTypeOf(p).toMatchTypeOf<Record<string, never>>();
    },
    "room:sync-ready": (p: Record<string, never>) => {
      expectTypeOf(p).toMatchTypeOf<Record<string, never>>();
    },
    "room:network-warning": (p: {
      reason: "ice-failed" | "rendezvous-unreachable" | "channel-closed" | "room-evicted";
    }) => {
      // room:network-warning payload narrows to the 4-value reason union (room-evicted — D25, §3.1)
      expectTypeOf(p.reason).toMatchTypeOf<
        "ice-failed" | "rendezvous-unreachable" | "channel-closed" | "room-evicted"
      >();
    }
  }),
  api: ctx => {
    // ctx.require(controllerPlugin) returns a ControllerApi — confirm joinRoom return type
    const controller = ctx.require(controllerPlugin);
    expectTypeOf(controller.joinRoom).toMatchTypeOf<(code: string) => Promise<void>>();
    expectTypeOf(controller.requestWakeLock).toMatchTypeOf<() => Promise<boolean>>();
    return {};
  }
});

// Ensure the plugin was created (use it to avoid unused-variable TS error)
expectTypeOf(padGame).not.toBeNever();

// ---------------------------------------------------------------------------
// Plain-JSON payload enforcement — a function payload must be a compile error
// ---------------------------------------------------------------------------

// Compose a minimal createPlugin just to get a typed controller require:
const _checkPayloadGame = createPlugin("_checkPayload", {
  depends: [controllerPlugin],
  api: ctx => {
    const controller = ctx.require(controllerPlugin);
    // @ts-expect-error — function is not JsonValue; the controller surface enforces plain-JSON payloads
    controller.intent("move", () => {});
    return {};
  }
});
expectTypeOf(_checkPayloadGame).not.toBeNever();

// ---------------------------------------------------------------------------
// Unknown event key must be rejected on the dependent's emit surface
// ---------------------------------------------------------------------------

const _checkBogusEvent = createPlugin("_checkBogusEvent", {
  depends: [controllerPlugin],
  hooks: ctx => ({
    "room:sync-ready": () => {
      // @ts-expect-error — "room:bogus" is not a known event key on the controller facade
      ctx.emit("room:bogus", {});
    }
  }),
  api: () => ({})
});
expectTypeOf(_checkBogusEvent).not.toBeNever();
