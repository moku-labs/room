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
import { createApp, MAX_CONTROLLERS, RoomFullError, stagePlugin } from "../../src/index";
import type { Bus } from "./helpers/harness";
import { makeBus, makeController, makeStage, sawEvent, siteCfg } from "./helpers/harness";

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

  it("sync.mutate on a never-registered namespace throws the prefixed [room] error", async () => {
    const bus = makeBus();
    const { app: stage } = makeStage(bus);
    await stage.start();

    // Same guard, reached via the role-agnostic sync surface rather than the stage facade.
    expect(() => stage.sync.mutate("ghost", s => s)).toThrow(/\[room\]/);

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

/**
 * Starts eight controllers and joins each of them to `code`.
 *
 * @param bus - The signaling bus the stage is on.
 * @param code - The stage's room code.
 * @returns The eight players and their join results.
 */
async function seatEight(bus: Bus, code: string) {
  const players = Array.from({ length: MAX_CONTROLLERS }, (_, index) =>
    makeController(bus, `fullSeat${index}`)
  );
  await Promise.all(players.map(p => p.app.start()));
  const results = await Promise.all(players.map(p => p.app.session.joinRoom(code)));
  return { players, results };
}

/**
 * Builds a stage with its own controller cap, so a refusal needs only a few apps.
 *
 * @param bus - The signaling bus to rendezvous on.
 * @param maxControllers - The cap to run with.
 * @returns The stage app.
 */
function makeCappedStage(bus: Bus, maxControllers: number) {
  return createApp({
    plugins: [stagePlugin],
    pluginConfigs: { ...siteCfg(bus), session: { generateQr: false, maxControllers } }
  });
}

describe("room edge cases — a full room is a join result", () => {
  it("the 8th joinRoom resolves; the 9th gets full from session and controller, role none, roster stays 8", async () => {
    const bus = makeBus();
    const { app: stage, captured: stageEvents } = makeStage(bus);
    await stage.start();
    const { code } = stage.stage.createRoom();

    const { players, results } = await seatEight(bus, code);
    expect(results.map(result => result.ok)).toEqual(Array.from({ length: 8 }, () => true));

    const viaSession = makeController(bus, "fullNinthSession");
    const viaFacade = makeController(bus, "fullNinthFacade");
    await viaSession.app.start();
    await viaFacade.app.start();

    await expect(viaSession.app.session.joinRoom(code)).resolves.toEqual({
      ok: false,
      reason: "full"
    });
    await expect(viaFacade.app.controller.joinRoom(code)).rejects.toThrow("full");

    for (const refused of [viaSession, viaFacade]) {
      expect(refused.app.session.self()).toMatchObject({ role: "none", roomCode: "" });
      expect(refused.app.session.hostId()).toBe("");
      expect(refused.app.session.roster()).toEqual([]);
      // Fullness is a result, not a connectivity event (contracts §6.2).
      expect(sawEvent(refused.captured, "room:network-warning")).toBe(false);
    }
    expect(stage.session.roster()).toHaveLength(MAX_CONTROLLERS);
    expect(stageEvents.filter(event => event.name === "room:peer-joined")).toHaveLength(
      MAX_CONTROLLERS
    );

    await Promise.all([...players, viaSession, viaFacade].map(controller => controller.app.stop()));
    await stage.stop();
  });

  it("a roster broadcast inside the close delay reaches the refused device and does not admit it", async () => {
    const bus = makeBus();
    const stage = makeCappedStage(bus, 1);
    await stage.start();
    const { code } = stage.stage.createRoom();
    const seated = makeController(bus, "delaySeated");
    const refused = makeController(bus, "delayRefused");
    await Promise.all([seated.app.start(), refused.app.start()]);
    await seated.app.session.joinRoom(code);
    const seen: string[] = [];
    refused.app.transport.wire().on((_peerId, frame) => {
      seen.push(frame.t);
    });

    // The bus reaches the host inside this call: `room-full` is on its way, and the peer is still connected.
    const joining = refused.app.session.joinRoom(code);
    stage.transport.wire().broadcast({
      t: "roster",
      roster: Object.fromEntries(stage.session.roster().map(entry => [entry.id, entry]))
    });

    await expect(joining).resolves.toEqual({ ok: false, reason: "full" });
    await vi.waitFor(() => {
      expect(seen).toEqual(["room-full", "roster"]);
    });
    expect(refused.app.session.self().role).toBe("none");
    expect(refused.app.session.roster()).toEqual([]);

    await Promise.all([seated.app.stop(), refused.app.stop()]);
    await stage.stop();
  });

  it("stop() inside the close delay leaves no timer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    try {
      const bus = makeBus();
      const stage = makeCappedStage(bus, 0);
      const phone = makeController(bus, "delayStopPhone");
      await stage.start();
      await phone.app.start();
      const { code } = stage.stage.createRoom();

      await expect(phone.app.session.joinRoom(code)).resolves.toEqual({
        ok: false,
        reason: "full"
      });
      await phone.app.stop();
      await stage.stop();

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an adapter that rejects with the public RoomFullError gives full and no warning", async () => {
    const refusing: Bus = { join: () => Promise.reject(new RoomFullError()) };
    const { app, captured } = makeController(refusing, "refusingAdapterPhone");
    await app.start();

    await expect(app.session.joinRoom("K7M2QX")).resolves.toEqual({ ok: false, reason: "full" });
    expect(sawEvent(captured, "room:network-warning")).toBe(false);
    expect(app.session.self().role).toBe("none");

    await app.stop();
  });

  it("a slot frees: the refused device retries on the same app and joins", async () => {
    const bus = makeBus();
    // A short heartbeat: the host learns a player left through it, and the default takes 6 s.
    const stage = createApp({
      plugins: [stagePlugin],
      pluginConfigs: {
        ...siteCfg(bus),
        transport: { signaling: bus, heartbeatIntervalMs: 50, heartbeatTimeoutMs: 400 }
      }
    });
    await stage.start();
    const { code } = stage.stage.createRoom();
    const { players } = await seatEight(bus, code);

    const refused = makeController(bus, "fullRetry");
    await refused.app.start();
    await expect(refused.app.session.joinRoom(code)).resolves.toEqual({
      ok: false,
      reason: "full"
    });
    // Asking again after the host dropped the refused peer, with the room still full, gets the same answer.
    const refusedId = refused.app.session.self().selfId;
    await vi.waitFor(() => {
      expect(stage.transport.peers()).not.toContain(refusedId);
    });
    await expect(refused.app.session.joinRoom(code)).resolves.toEqual({
      ok: false,
      reason: "full"
    });

    await players[0]?.app.session.leave();
    await vi.waitFor(
      () => {
        expect(stage.session.roster()).toHaveLength(MAX_CONTROLLERS - 1);
      },
      { timeout: 5000 }
    );

    const retried = await refused.app.session.joinRoom(code);

    const selfId = refused.app.session.self().selfId;
    expect(retried).toEqual({ ok: true, selfId });
    expect(refused.app.session.self()).toMatchObject({ role: "controller", roomCode: code });
    expect(refused.app.session.hostId()).toBe(stage.session.self().selfId);
    expect(stage.session.roster().map(entry => entry.id)).toContain(selfId);
    expect(stage.session.roster()).toHaveLength(MAX_CONTROLLERS);

    await Promise.all([...players, refused].map(controller => controller.app.stop()));
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
