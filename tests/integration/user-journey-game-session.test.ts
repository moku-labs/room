/**
 * @file Framework-level USER-JOURNEY integration tests for `@moku-labs/room` — full couch-multiplayer
 * game sessions driven end-to-end through the public role facades over a shared in-memory signaling bus.
 *
 * Each test stands up ONE authoritative stage (host / shared screen) plus N controllers (phones) via the
 * shared `./helpers/harness` (which composes the public `[stagePlugin]` / `[controllerPlugin]`
 * arrays through `@moku-labs/web`'s `createApp`, exactly as a consumer game would), then plays a realistic
 * round: controllers send INTENTS, the host validates + applies them by mutating authoritative SYNC slices
 * and broadcasting, and controllers READ the synced replica. The model is star-topology + host-authoritative
 * (00-contracts §6): controllers never mutate shared state directly, they only emit intents and read deltas.
 *
 * Async note: cross-app delivery rides a microtask pipe over the `inMemory()` bus, so every assertion on
 * delivered state uses `vi.waitFor(...)` rather than an arbitrary sleep. Slice-visibility note: a
 * freshly-registered slice reaches an already-joined controller via the host's join-baseline snapshot
 * (register-THEN-join) OR a post-join `mutate` + `broadcast` (a plain delta of a never-mutated slice does
 * not carry it) — both patterns are exercised below, mirroring the controller integration suite.
 *
 * Scenario 6 limitation: transport's `onPeerLost` is documented as NOT firing on a clean teardown/close
 * (`src/plugins/transport/types.ts`), so a controller `app.stop()` does not deterministically drive
 * `room:peer-left` / host-roster removal over the in-memory bus. That journey therefore asserts the
 * deterministic JOIN-side roster growth and the clean post-stop lifecycle, and documents the removal gap.
 */
import { describe, expect, it, vi } from "vitest";
import { makeBus, makeController, makeStage, sawEvent } from "./helpers/harness";

// ---------------------------------------------------------------------------
// Journey 1 — single-player scoreboard: intent → host mutate → replica read
// ---------------------------------------------------------------------------

describe("user journey — single-player scoreboard game", () => {
  it("controller scores two points; host applies each intent and the replica reads 2", async () => {
    const bus = makeBus();
    const { app: stage } = makeStage(bus);
    const { app: phone } = makeController(bus, "scoreboardPhone");

    await stage.start();
    await phone.start();

    // Host opens the room; phone joins it.
    const { code } = stage.stage.createRoom();
    await phone.controller.joinRoom(code);

    // Host waits to actually see the controller before wiring gameplay (roster-gated, like the gold ref).
    await vi.waitFor(() => expect(stage.session.roster()).toHaveLength(1), { timeout: 5000 });

    // Host declares the authoritative scoreboard slice + the "point" intent and its handler.
    stage.sync.registerSlice("scores", { me: 0 });
    stage.intent.register("point", {
      fields: { value: { type: "number", min: 0, max: 100 } },
      additionalFields: true
    });
    stage.stage.onIntent("point", (payload, _peerId) => {
      const inc = (payload as { value?: number }).value ?? 1;
      stage.stage.mutate("scores", s => ({ ...s, me: ((s.me as number) ?? 0) + inc }));
    });

    // Phone fires the same intent twice — fire-and-forget; the host acks via synced state.
    phone.controller.intent("point", { value: 1 });
    phone.controller.intent("point", { value: 1 });

    // The host applied both; the replica converges on me === 2.
    await vi.waitFor(
      () => {
        expect(phone.controller.read("scores")?.me).toBe(2);
      },
      { timeout: 5000 }
    );

    await phone.stop();
    await stage.stop();
  });
});

// ---------------------------------------------------------------------------
// Journey 2 — two-player competitive: per-peer state keyed by peerId
// ---------------------------------------------------------------------------

describe("user journey — two-player competitive match", () => {
  it("two phones each drive their own cell via intents; BOTH replicas converge on the shared two-entry map", async () => {
    // Two phones share one screen. The host keeps per-player state in ONE authoritative slice keyed by
    // peerId — each player owns a cell driven by its OWN controller→host intent — and every phone reads
    // the SAME slice (couch-multiplayer: one screen, N readers). Exercises finding #1's fix: BOTH
    // controllers' intents reach the host (no host-target clobber), the host writes each peer's cell, and
    // the host→all delta fan-out converges both replicas. The slice is registered before the phones join
    // so each join baseline carries it; then each phone's intent drives its own cell.
    const bus = makeBus();
    const { app: stage } = makeStage(bus);
    const { app: p1 } = makeController(bus, "competitiveP1");
    const { app: p2 } = makeController(bus, "competitiveP2");

    await stage.start();
    await p1.start();
    await p2.start();

    const { code } = stage.stage.createRoom();

    // Register the shared per-peer slice + the "move" intent BEFORE the phones join, so each join
    // baseline carries "players" and the host applies each phone's move to that phone's own cell.
    stage.sync.registerSlice("players", {});
    stage.intent.register("move", {
      fields: { value: { type: "number" } },
      additionalFields: true
    });
    stage.stage.onIntent("move", (payload, peerId) => {
      stage.stage.mutate("players", d => ({
        ...d,
        [peerId]: (payload as { value: number }).value
      }));
      stage.stage.broadcast();
    });

    await p1.controller.joinRoom(code);
    await p2.controller.joinRoom(code);
    await vi.waitFor(() => expect(stage.session.roster()).toHaveLength(2), { timeout: 5000 });

    // Each phone drives its OWN cell via a real controller→host intent (finding #1 fix: both arrive).
    p1.controller.intent("move", { value: 11 });
    p2.controller.intent("move", { value: 22 });

    // BOTH replicas converge on the same two-entry per-peer map.
    await vi.waitFor(
      () => {
        const seen1 = p1.controller.read("players");
        const seen2 = p2.controller.read("players");
        expect(seen1 && Object.keys(seen1)).toHaveLength(2);
        expect(seen2 && Object.keys(seen2)).toHaveLength(2);
      },
      { timeout: 5000 }
    );

    // Each phone sees BOTH players' values (order-independent), matching the host-authoritative slice.
    const onP1 = Object.values(p1.controller.read("players") as Record<string, number>);
    const onP2 = Object.values(p2.controller.read("players") as Record<string, number>);
    expect(onP1.toSorted((a, b) => a - b)).toEqual([11, 22]);
    expect(onP2.toSorted((a, b) => a - b)).toEqual([11, 22]);

    await p1.stop();
    await p2.stop();
    await stage.stop();
  });
});

// ---------------------------------------------------------------------------
// Journey 3 — late joiner inherits the current authoritative state on join
// ---------------------------------------------------------------------------

describe("user journey — late joiner admitted into an in-progress game", () => {
  it("a phone joins a game already in progress and its replica inherits the live score", async () => {
    // P1 plays for a while and runs the score up through real intents; a friend then picks up a second
    // phone mid-game. The late phone is admitted into the in-progress session (its join resolves, the host
    // roster grows) AND its replica inherits the current authoritative score — finding #2's fix: the host's
    // join-baseline snapshot (sendBaselineSnapshot on room:peer-joined) now reaches the late joiner (the
    // star-aware bus no longer corrupts its host channel), carrying the full current state.
    const bus = makeBus();
    const { app: stage } = makeStage(bus);
    const { app: p1 } = makeController(bus, "lateJoinP1");
    const { app: p2 } = makeController(bus, "lateJoinP2");

    await stage.start();
    await p1.start();

    const { code } = stage.stage.createRoom();
    await p1.controller.joinRoom(code);
    await vi.waitFor(() => expect(stage.session.roster()).toHaveLength(1), { timeout: 5000 });

    // Host runs some of the game with only P1 present: a "scores" slice accrues to 7 via P1's intents.
    stage.sync.registerSlice("scores", { total: 0 });
    stage.intent.register("add", {
      fields: { n: { type: "number", min: 0, max: 100 } },
      additionalFields: true
    });
    stage.stage.onIntent("add", (payload, _peerId) => {
      stage.stage.mutate("scores", s => ({
        ...s,
        total: ((s.total as number) ?? 0) + (payload as { n: number }).n
      }));
    });

    p1.controller.intent("add", { n: 4 });
    p1.controller.intent("add", { n: 3 });
    await vi.waitFor(() => expect(stage.sync.read("scores")?.total).toBe(7), { timeout: 5000 });

    // The friend's late phone joins mid-game — the join must resolve against the live room.
    await p2.start();
    await expect(p2.controller.joinRoom(code)).resolves.toBeUndefined();

    // The host admits it: the roster grows to include the late device.
    await vi.waitFor(() => expect(stage.session.roster()).toHaveLength(2), { timeout: 5000 });

    // Host-authoritative truth is unchanged by the late admission...
    expect(stage.sync.read("scores")?.total).toBe(7);

    // ...and the late joiner's replica inherits it via the host's join-baseline snapshot (finding #2 fix).
    await vi.waitFor(() => expect(p2.controller.read("scores")?.total).toBe(7), { timeout: 5000 });

    await p1.stop();
    await p2.stop();
    await stage.stop();
  });
});

// ---------------------------------------------------------------------------
// Journey 4 — round/phase progression observed in order via on()
// ---------------------------------------------------------------------------

describe("user journey — round phase progression", () => {
  it("a controller's on('round') observes lobby → playing → over in order", async () => {
    const bus = makeBus();
    const { app: stage } = makeStage(bus);
    const { app: phone } = makeController(bus, "roundPhone");

    await stage.start();
    await phone.start();

    const { code } = stage.stage.createRoom();

    // Register the round slice BEFORE the controller joins so the join-baseline snapshot carries it
    // (a plain delta of a never-mutated slice would not deliver a freshly-registered ns — gold-ref note).
    stage.sync.registerSlice("round", { phase: "lobby" });
    await phone.controller.joinRoom(code);

    // Wait for the baseline replica, then subscribe — on() fires once immediately with the current value.
    await vi.waitFor(() => expect(phone.controller.read("round")).toBeDefined(), { timeout: 5000 });

    const phases: string[] = [];
    const off = phone.controller.on("round", v => phases.push(v.phase as string));

    await vi.waitFor(() => expect(phases).toContain("lobby"), { timeout: 5000 });

    // Host drives the game through its phases, broadcasting each transition.
    stage.stage.mutate("round", d => ({ ...d, phase: "playing" }));
    stage.stage.broadcast();
    await vi.waitFor(() => expect(phases).toContain("playing"), { timeout: 5000 });

    stage.stage.mutate("round", d => ({ ...d, phase: "over" }));
    stage.stage.broadcast();
    await vi.waitFor(() => expect(phases).toContain("over"), { timeout: 5000 });

    off();

    // The three phases arrived in causal order on the replica.
    const firstLobby = phases.indexOf("lobby");
    const firstPlaying = phases.indexOf("playing");
    const firstOver = phases.indexOf("over");
    expect(firstLobby).toBeLessThan(firstPlaying);
    expect(firstPlaying).toBeLessThan(firstOver);

    await phone.stop();
    await stage.stop();
  });
});

// ---------------------------------------------------------------------------
// Journey 5 — live running total across many deltas accumulates to the final value
// ---------------------------------------------------------------------------

describe("user journey — live running total across many deltas", () => {
  it("a controller subscription tracks each tick and ends at the final counter value", async () => {
    const bus = makeBus();
    const { app: stage } = makeStage(bus);
    const { app: phone } = makeController(bus, "counterPhone");

    await stage.start();
    await phone.start();

    const { code } = stage.stage.createRoom();

    stage.sync.registerSlice("counter", { n: 0 });
    await phone.controller.joinRoom(code);
    await vi.waitFor(() => expect(phone.controller.read("counter")).toBeDefined(), {
      timeout: 5000
    });

    const observed: number[] = [];
    const off = phone.controller.on("counter", v => observed.push(v.n as number));

    // Host emits a stream of authoritative increments, each its own broadcast tick.
    for (let i = 1; i <= 5; i++) {
      stage.stage.mutate("counter", d => ({ ...d, n: i }));
      stage.stage.broadcast();
    }

    // The replica converges on the final value; the subscription saw the ramp.
    await vi.waitFor(
      () => {
        expect(observed.at(-1)).toBe(5);
      },
      { timeout: 5000 }
    );
    expect(phone.controller.read("counter")?.n).toBe(5);
    expect(observed.length).toBeGreaterThanOrEqual(2);

    off();
    await phone.stop();
    await stage.stop();
  });
});

// ---------------------------------------------------------------------------
// Journey 6 — roster lifecycle: joins grow the roster; clean stop limitation documented
// ---------------------------------------------------------------------------

describe("user journey — roster lifecycle in a session", () => {
  it("each join grows the host roster and fires peer-joined; clean stop leaves the session healthy", async () => {
    const bus = makeBus();
    const { app: stage, captured: stageCaptured } = makeStage(bus);
    const { app: p1 } = makeController(bus, "rosterP1");
    const { app: p2 } = makeController(bus, "rosterP2");

    await stage.start();
    await p1.start();
    await p2.start();

    const { code } = stage.stage.createRoom();

    // First join → roster grows to 1.
    await p1.controller.joinRoom(code);
    await vi.waitFor(() => expect(stage.session.roster()).toHaveLength(1), { timeout: 5000 });

    // Second join → roster grows to 2.
    await p2.controller.joinRoom(code);
    await vi.waitFor(() => expect(stage.session.roster()).toHaveLength(2), { timeout: 5000 });

    // The host observed room:peer-joined through the depends:[stagePlugin] probe edge.
    expect(sawEvent(stageCaptured, "room:peer-joined")).toBe(true);

    // A controller leaves. NOTE: transport's onPeerLost is documented as NOT firing on a clean
    // teardown/close (src/plugins/transport/types.ts), so room:peer-left / roster removal is not
    // deterministic over the in-memory bus on app.stop(). We assert the clean lifecycle here and keep
    // the deterministic join-side growth (roster === 2) as the roster-lifecycle proof.
    await expect(p2.stop()).resolves.toBeUndefined();

    // The session is still healthy for the remaining peer (host + p1 keep running).
    expect(stage.session.roster().length).toBeGreaterThanOrEqual(1);

    await p1.stop();
    await stage.stop();
  });
});
