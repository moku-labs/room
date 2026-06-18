/**
 * @file Cross-plugin integration scenarios for the Room pack composed through the public pre-bundled
 * arrays (`roomPlugins.stage` / `roomPlugins.controller`) over the deterministic `inMemory()` signaling
 * bus (DOM-free, no `RTCPeerConnection`). Each test stands up ONE stage (host) app plus N controller
 * (phone) apps on a single shared bus and drives them only through the public facades (`app.stage.*` /
 * `app.controller.*`) and the shared engines (`app.sync.*` / `app.intent.*` / `app.session.*`) — never
 * direct plugin imports. The focus is the seams BETWEEN plugins: sync slice fan-out + replica reads +
 * reactive subscriptions, intent round-trips from controller→host→authoritative state, multi-controller
 * roster growth, late-join baseline snapshots, and the WARN-2 event-visibility guarantee (a single
 * `depends:[facade]` consumer probe still receives every `room:*` event). Cross-app delivery rides a
 * microtask pipe, so every assertion on delivered state uses `vi.waitFor`; a single short settle wait
 * proves the one negative (a callback that must NOT fire after `off()`).
 */

import { describe, expect, it, vi } from "vitest";
import { makeBus, makeController, makeStage, sawEvent } from "./helpers/harness";

// ---------------------------------------------------------------------------
// Sync — slice fan-out, replica reads, reactive subscriptions, late join
// ---------------------------------------------------------------------------

describe("cross-plugin sync — host slice fan-out to controller replicas", () => {
  it("host seeds a slice → room:sync-ready fires on the controller and read(ns) returns the host value", async () => {
    const bus = makeBus();
    const { app: stageApp } = makeStage(bus);
    const { app: ctrlApp, captured } = makeController(bus, "ctrlSyncReady");

    await stageApp.start();
    await ctrlApp.start();

    const { code } = stageApp.stage.createRoom();
    await ctrlApp.controller.joinRoom(code);

    // Host seeds a slice + mutates it (marks dirty) + flushes a delta so the controller applies it.
    stageApp.sync.registerSlice("scores", { p1: 0, p2: 0 });
    stageApp.sync.mutate("scores", s => ({ ...s, p1: 42 }));
    stageApp.stage.broadcast();

    // The first applied frame flips room:sync-ready on the controller probe.
    await vi.waitFor(() => expect(sawEvent(captured, "room:sync-ready")).toBe(true), {
      timeout: 5000
    });

    // Once ready, the controller's read() returns the authoritative host value.
    await vi.waitFor(
      () => {
        const scores = ctrlApp.controller.read("scores");
        expect(scores?.p1).toBe(42);
      },
      { timeout: 5000 }
    );

    await ctrlApp.stop();
    await stageApp.stop();
  });

  it("on(ns, cb) fires with the current value, again after a host mutate, and stops after off()", async () => {
    const bus = makeBus();
    const { app: stageApp } = makeStage(bus);
    const { app: ctrlApp } = makeController(bus, "ctrlReactive");

    await stageApp.start();
    await ctrlApp.start();

    const { code } = stageApp.stage.createRoom();

    // Register the slice BEFORE the controller joins so the join baseline snapshot seeds the replica
    // (registerSlice seeds the host snapshot but does NOT mark it dirty, so the realistic delivery path
    // for a freshly-registered slice is register-then-join → sendBaselineSnapshot).
    stageApp.sync.registerSlice("round", { n: 1 });
    await ctrlApp.controller.joinRoom(code);

    // Wait for the baseline snapshot to seed the replica.
    await vi.waitFor(() => expect(ctrlApp.controller.read("round")).toBeDefined(), {
      timeout: 5000
    });

    // Subscribe AFTER the replica is ready; the callback fires once immediately with the current value.
    const received: Array<Readonly<Record<string, unknown>>> = [];
    const off = ctrlApp.controller.on("round", v => received.push(v));

    await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 1000 });
    expect(received[0]).toMatchObject({ n: 1 });

    // Host mutates + broadcasts a delta — the callback fires again with the new value.
    stageApp.stage.mutate("round", d => ({ ...d, n: 2 }));
    stageApp.stage.broadcast();

    await vi.waitFor(() => expect(received.length).toBeGreaterThanOrEqual(2), { timeout: 5000 });
    expect(received.at(-1)).toMatchObject({ n: 2 });

    // Unsubscribe — subsequent host mutations must NOT fire the callback.
    off();
    const countAfterOff = received.length;

    stageApp.stage.mutate("round", d => ({ ...d, n: 3 }));
    stageApp.stage.broadcast();

    // Allow a short window for any pending async delivery, then assert the negative.
    await new Promise<void>(r => setTimeout(r, 100));
    expect(received).toHaveLength(countAfterOff);

    await ctrlApp.stop();
    await stageApp.stop();
  });

  it("late join — a slice registered + mutated before join arrives in the join baseline snapshot", async () => {
    const bus = makeBus();
    const { app: stageApp } = makeStage(bus);
    const { app: ctrlApp } = makeController(bus, "ctrlLateJoin");

    await stageApp.start();
    await ctrlApp.start();

    const { code } = stageApp.stage.createRoom();

    // Host fully establishes the slice BEFORE the controller ever joins.
    stageApp.sync.registerSlice("phase", { name: "lobby" });
    stageApp.sync.mutate("phase", p => ({ ...p, name: "playing" }));

    await ctrlApp.controller.joinRoom(code);

    // The late-joiner's baseline snapshot carries the latest value, not the initial.
    await vi.waitFor(
      () => {
        expect(ctrlApp.controller.read("phase")?.name).toBe("playing");
      },
      { timeout: 5000 }
    );

    await ctrlApp.stop();
    await stageApp.stop();
  });

  it("multiple namespaces — two slices mutated then broadcast are each read back independently", async () => {
    const bus = makeBus();
    const { app: stageApp } = makeStage(bus);
    const { app: ctrlApp } = makeController(bus, "ctrlMultiNs");

    await stageApp.start();
    await ctrlApp.start();

    const { code } = stageApp.stage.createRoom();
    await ctrlApp.controller.joinRoom(code);

    // Two independent slices, both seeded + mutated, flushed in one broadcast.
    stageApp.sync.registerSlice("scores", { p1: 0 });
    stageApp.sync.registerSlice("clock", { sec: 0 });
    stageApp.sync.mutate("scores", s => ({ ...s, p1: 7 }));
    stageApp.sync.mutate("clock", c => ({ ...c, sec: 90 }));
    stageApp.stage.broadcast();

    // Each namespace resolves to its own value on the replica.
    await vi.waitFor(
      () => {
        expect(ctrlApp.controller.read("scores")?.p1).toBe(7);
        expect(ctrlApp.controller.read("clock")?.sec).toBe(90);
      },
      { timeout: 5000 }
    );

    await ctrlApp.stop();
    await stageApp.stop();
  });
});

// ---------------------------------------------------------------------------
// Intent — controller → host round-trip, ordering, per-controller addressing
// ---------------------------------------------------------------------------

describe("cross-plugin intent — controller input to authoritative host state", () => {
  it("intent round-trip — host handler receives (payload, peerId) and the ensuing mutate reaches the controller", async () => {
    const bus = makeBus();
    const { app: stageApp } = makeStage(bus);
    const { app: ctrlApp } = makeController(bus, "ctrlIntentTrip");

    await stageApp.start();
    await ctrlApp.start();

    const { code } = stageApp.stage.createRoom();
    await ctrlApp.controller.joinRoom(code);

    // Host must see the controller in the roster before the intent's wire.send target resolves.
    await vi.waitFor(() => expect(stageApp.session.roster()).toHaveLength(1), { timeout: 5000 });

    // Register the schema + a slice, then subscribe a handler that folds the intent into state.
    stageApp.sync.registerSlice("players", {});
    stageApp.intent.register("move", {
      fields: { dx: { type: "number", min: -1, max: 1 } },
      additionalFields: true
    });

    const received: Array<{ payload: unknown; peerId: string }> = [];
    stageApp.stage.onIntent("move", (payload, peerId) => {
      received.push({ payload, peerId });
      stageApp.stage.mutate("players", d => ({ ...d, [peerId]: payload as never }));
    });

    // Controller fires one intent.
    ctrlApp.controller.intent("move", { dx: 1 });

    // The host handler runs with the validated payload + the sender's peerId.
    await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 5000 });
    expect(received[0]?.payload).toEqual({ dx: 1 });
    expect(typeof received[0]?.peerId).toBe("string");
    expect(received[0]?.peerId.length).toBeGreaterThan(0);

    // The host's resulting mutate is observable on the controller replica, keyed by the same peerId.
    const peerId = received[0]?.peerId as string;
    await vi.waitFor(
      () => {
        expect(ctrlApp.controller.read("players")?.[peerId]).toEqual({ dx: 1 });
      },
      { timeout: 5000 }
    );

    await ctrlApp.stop();
    await stageApp.stop();
  });

  it("sequential intents — two intents of the same name invoke the host handler twice, in order", async () => {
    const bus = makeBus();
    const { app: stageApp } = makeStage(bus);
    const { app: ctrlApp } = makeController(bus, "ctrlIntentSeq");

    await stageApp.start();
    await ctrlApp.start();

    const { code } = stageApp.stage.createRoom();
    await ctrlApp.controller.joinRoom(code);

    await vi.waitFor(() => expect(stageApp.session.roster()).toHaveLength(1), { timeout: 5000 });

    stageApp.intent.register("tap", {
      fields: { n: { type: "number" } },
      additionalFields: true
    });

    const order: number[] = [];
    stageApp.stage.onIntent("tap", payload => {
      order.push((payload as { n: number }).n);
    });

    // Two intents, sent in order; cSeq de-dup preserves order and admits both.
    ctrlApp.controller.intent("tap", { n: 1 });
    ctrlApp.controller.intent("tap", { n: 2 });

    await vi.waitFor(() => expect(order).toHaveLength(2), { timeout: 5000 });
    expect(order).toEqual([1, 2]);

    await ctrlApp.stop();
    await stageApp.stop();
  });

  it("multi-controller intent attribution — two controllers' intents reach the host with distinct peerIds", async () => {
    // Finding #1 fix: the star-aware inMemory bus (controllers no longer mesh with each other) + the
    // controller host-id guard (a stable controller ignores non-host connections) keep BOTH controllers
    // pointed at the host, so each one's intents arrive and are attributed to its own roster peerId.
    // (Pre-fix, a 2nd controller clobbered the 1st's host target and the 1st's intents were lost.)
    const bus = makeBus();
    const { app: stageApp } = makeStage(bus);
    const { app: ctrlA } = makeController(bus, "ctrlAddrA");
    const { app: ctrlB } = makeController(bus, "ctrlAddrB");

    await stageApp.start();
    await ctrlA.start();
    await ctrlB.start();

    const { code } = stageApp.stage.createRoom();
    await ctrlA.controller.joinRoom(code);
    await ctrlB.controller.joinRoom(code);

    await vi.waitFor(() => expect(stageApp.session.roster()).toHaveLength(2), { timeout: 5000 });

    stageApp.intent.register("ping", { fields: {}, additionalFields: true });

    const peerIds = new Set<string>();
    stageApp.stage.onIntent("ping", (_payload, peerId) => {
      peerIds.add(peerId);
    });

    ctrlA.controller.intent("ping", { from: "a" });
    ctrlB.controller.intent("ping", { from: "b" });

    // Both controllers' intents reach the host, attributed to two distinct roster peerIds.
    await vi.waitFor(() => expect(peerIds.size).toBe(2), { timeout: 5000 });
    const rosterIds = new Set(stageApp.session.roster().map(e => e.id));
    for (const id of peerIds) expect(rosterIds.has(id)).toBe(true);

    await ctrlA.stop();
    await ctrlB.stop();
    await stageApp.stop();
  });
});

// ---------------------------------------------------------------------------
// WARN-2 — single-edge event visibility + multi-controller roster
// ---------------------------------------------------------------------------

describe("cross-plugin composition — WARN-2 event visibility + roster growth", () => {
  it("two controllers join one room → the host roster reaches length 2", async () => {
    const bus = makeBus();
    const { app: stageApp } = makeStage(bus);
    const { app: ctrlApp1 } = makeController(bus, "ctrlRosterA");
    const { app: ctrlApp2 } = makeController(bus, "ctrlRosterB");

    await stageApp.start();
    await ctrlApp1.start();
    await ctrlApp2.start();

    const { code } = stageApp.stage.createRoom();
    await ctrlApp1.controller.joinRoom(code);
    await ctrlApp2.controller.joinRoom(code);

    await vi.waitFor(() => expect(stageApp.session.roster()).toHaveLength(2), { timeout: 5000 });

    await ctrlApp1.stop();
    await ctrlApp2.stop();
    await stageApp.stop();
  });

  it("WARN-2 host side — the depends:[stagePlugin] probe receives room:sync-ready", async () => {
    const bus = makeBus();
    const { app: stageApp, captured: stageCaptured } = makeStage(bus, "stageWarn2Probe");
    const { app: ctrlApp } = makeController(bus, "ctrlWarn2Host");

    await stageApp.start();
    await ctrlApp.start();

    const { code } = stageApp.stage.createRoom();
    await ctrlApp.controller.joinRoom(code);

    // Seeding + the first export flips the HOST's own room:sync-ready, seen through the stage probe edge.
    stageApp.sync.registerSlice("game", { phase: "lobby" });
    stageApp.stage.broadcast();

    await vi.waitFor(() => expect(sawEvent(stageCaptured, "room:sync-ready")).toBe(true), {
      timeout: 5000
    });

    await ctrlApp.stop();
    await stageApp.stop();
  });

  it("WARN-2 controller side — the depends:[controllerPlugin] probe receives room:sync-ready", async () => {
    const bus = makeBus();
    const { app: stageApp } = makeStage(bus);
    const { app: ctrlApp, captured: ctrlCaptured } = makeController(bus, "ctrlWarn2Probe");

    await stageApp.start();
    await ctrlApp.start();

    const { code } = stageApp.stage.createRoom();
    await ctrlApp.controller.joinRoom(code);

    // Seed + mutate + flush so the controller applies a frame and flips room:sync-ready through the
    // single controllerPlugin facade edge (WARN-2 runtime closure proof).
    stageApp.sync.registerSlice("game", { phase: "lobby" });
    stageApp.sync.mutate("game", g => ({ ...g, phase: "playing" }));
    stageApp.stage.broadcast();

    await vi.waitFor(() => expect(sawEvent(ctrlCaptured, "room:sync-ready")).toBe(true), {
      timeout: 5000
    });

    await ctrlApp.stop();
    await stageApp.stop();
  });
});
