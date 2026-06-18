/**
 * @file Framework-level integration tests for `@moku-labs/room` EDGE CASES and ERROR CONDITIONS,
 * composed through the public `roomPlugins.*` arrays via the shared `tests/integration/helpers/harness`
 * (the consumer-shaped path: `createApp` over the pre-bundled role arrays, the DOM-free `inMemory()`
 * signaling bus). Each scenario was confirmed against the live source before asserting — these are
 * deliberately the unhappy paths: an unregistered-slice mutate (synchronous throw from the sync
 * engine), an out-of-range intent payload (silently dropped by the host receive shape-check so the
 * handler never fires), the `MAX_CONTROLLERS` 8-cap (eight controllers all reach the host roster),
 * and the graceful no-ops (broadcast before any slice, roster before createRoom, double stop). Async
 * cross-app delivery rides a microtask pipe, so positive assertions use `vi.waitFor(...)` and the
 * negative (handler-NOT-invoked) assertion settles with a fixed wait before asserting the count is
 * unchanged — the same pattern the controller suite's `off()` test uses.
 */
import { describe, expect, it, vi } from "vitest";
import { MAX_CONTROLLERS } from "../../src/index";
import { makeBus, makeController, makeStage } from "./helpers/harness";

describe("room edge cases — unregistered-slice mutate", () => {
  it("stage.mutate on a never-registered namespace throws synchronously", async () => {
    const bus = makeBus();
    const { app: stage } = makeStage(bus);
    await stage.start();

    // The slice "nope" was never registered via registerSlice — the sync engine's mutate guard
    // throws synchronously (it is not an async/Promise rejection).
    expect(() => stage.stage.mutate("nope", d => d)).toThrow();
    expect(() => stage.stage.mutate("nope", d => d)).toThrow(/not registered/);

    await stage.stop();
  });

  it("sync.mutate on a never-registered namespace throws the prefixed [moku-labs/room] error", async () => {
    const bus = makeBus();
    const { app: stage } = makeStage(bus);
    await stage.start();

    // Same guard, reached via the role-agnostic sync surface rather than the stage facade.
    expect(() => stage.sync.mutate("ghost", s => s)).toThrow(/\[moku-labs\/room\]/);

    await stage.stop();
  });
});

describe("room edge cases — invalid intent payload", () => {
  it("an out-of-range intent payload is dropped host-side; the handler is never invoked", async () => {
    const bus = makeBus();
    const { app: stage } = makeStage(bus);
    const { app: ctrl } = makeController(bus, "edgeInvalidIntentCtrl");

    await stage.start();
    await ctrl.start();

    const { code } = stage.stage.createRoom();
    await ctrl.controller.joinRoom(code);

    // Wait until the host sees the controller before sending any intent.
    await vi.waitFor(
      () => {
        expect(stage.session.roster()).toHaveLength(1);
      },
      { timeout: 10_000 }
    );

    // Register a constrained "move" schema (dx ∈ [-1, 1]) + an authoritative handler.
    const received: Array<{ payload: unknown; peerId: string }> = [];
    stage.intent.register("move", {
      fields: { dx: { type: "number", min: -1, max: 1 } },
      additionalFields: true
    });
    stage.stage.onIntent("move", (payload, peerId) => {
      received.push({ payload, peerId });
    });

    // dx = 5 is outside [-1, 1] → the correctness-only shape-check fails → frame dropped → no dispatch.
    ctrl.controller.intent("move", { dx: 5 });

    // Negative proof: settle for any pending async delivery, then assert nothing was dispatched.
    await new Promise<void>(r => setTimeout(r, 200));
    expect(received).toHaveLength(0);

    await ctrl.stop();
    await stage.stop();
  });

  it("a valid in-range payload IS dispatched — proving the shape-check discriminates", async () => {
    const bus = makeBus();
    const { app: stage } = makeStage(bus);
    const { app: ctrl } = makeController(bus, "edgeValidIntentCtrl");

    await stage.start();
    await ctrl.start();

    const { code } = stage.stage.createRoom();
    await ctrl.controller.joinRoom(code);

    await vi.waitFor(
      () => {
        expect(stage.session.roster()).toHaveLength(1);
      },
      { timeout: 10_000 }
    );

    const received: Array<{ payload: unknown; peerId: string }> = [];
    stage.intent.register("move", {
      fields: { dx: { type: "number", min: -1, max: 1 } },
      additionalFields: true
    });
    stage.stage.onIntent("move", (payload, peerId) => {
      received.push({ payload, peerId });
    });

    // dx = 1 is the inclusive upper bound → passes the shape-check → dispatched to the handler.
    ctrl.controller.intent("move", { dx: 1 });

    await vi.waitFor(
      () => {
        expect(received).toHaveLength(1);
      },
      { timeout: 10_000 }
    );
    expect(received[0]?.payload).toEqual({ dx: 1 });

    await ctrl.stop();
    await stage.stop();
  });
});

describe("room edge cases — MAX_CONTROLLERS cap", () => {
  it("exports the 8-controller cap as MAX_CONTROLLERS", () => {
    expect(MAX_CONTROLLERS).toBe(8);
  });

  it("all MAX_CONTROLLERS controllers join one room; the host roster reaches the cap", async () => {
    const bus = makeBus();
    const { app: stage } = makeStage(bus);

    const controllers = Array.from({ length: MAX_CONTROLLERS }, (_, index) =>
      makeController(bus, `edgeCapCtrl${index}`)
    );

    await stage.start();
    await Promise.all(controllers.map(c => c.app.start()));

    const { code } = stage.stage.createRoom();

    // Every controller joins the same room code.
    await Promise.all(controllers.map(c => c.app.controller.joinRoom(code)));

    // The host roster fills to exactly MAX_CONTROLLERS (the cap value, 8).
    await vi.waitFor(
      () => {
        expect(stage.session.roster()).toHaveLength(MAX_CONTROLLERS);
      },
      { timeout: 10_000 }
    );

    expect(stage.session.roster()).toHaveLength(MAX_CONTROLLERS);

    await Promise.all(controllers.map(c => c.app.stop()));
    await stage.stop();
  });
});

describe("room edge cases — graceful no-ops", () => {
  it("stage.broadcast() before any slice is registered does not throw", async () => {
    const bus = makeBus();
    const { app: stage } = makeStage(bus);
    await stage.start();

    // No slice registered, no peers connected — broadcast is a clean no-op (skipEmptyDeltas default).
    expect(() => stage.stage.broadcast()).not.toThrow();

    await stage.stop();
  });

  it("stage.roster() before createRoom() returns an empty array", async () => {
    const bus = makeBus();
    const { app: stage } = makeStage(bus);
    await stage.start();

    const roster = stage.stage.roster();
    expect(Array.isArray(roster)).toBe(true);
    expect(roster).toHaveLength(0);

    await stage.stop();
  });

  it("calling app.stop() twice resolves without throwing", async () => {
    const bus = makeBus();
    const { app: stage } = makeStage(bus);
    await stage.start();

    await expect(stage.stop()).resolves.toBeUndefined();
    await expect(stage.stop()).resolves.toBeUndefined();
  });
});

describe("room edge cases — joinRoom interrupted by app.stop() (finding #3)", () => {
  it("a join pending at stop() settles immediately, with no dangling 10s reconnect timer", async () => {
    const bus = makeBus();
    const { app: ctrl } = makeController(bus, "edgeJoinThenStop");
    await ctrl.start();

    // No stage ever created this code, so the host never connects and the join stays pending. Pre-fix
    // it would hang until the 10s reconnect timer (which itself survived teardown); the fix clears the
    // timer and settles the pending resolver on stop(), so the join rejects right away — this test would
    // exceed vitest's default 5s timeout if the join still waited on the 10s timer.
    const joinPromise = ctrl.controller.joinRoom("ZZZZZZ");

    await ctrl.stop();

    // The interrupted join settles as a failure (the controller facade throws the JoinResult reason).
    await expect(joinPromise).rejects.toThrow();
  });
});
