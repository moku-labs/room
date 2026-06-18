/**
 * Unit tests for the per-app `SyncEngine` (`engine.ts`): slice registry, dirty-flag, sSeq monotonicity,
 * throttle coalescing (fake timers at `broadcastHz`), gap detection, subscription firing, frozen reads,
 * and the single `room:sync-ready` emit. Transport `Wire` mocked (`broadcast`/`send`/`on` as `vi.fn()`).
 *
 * @file
 * @see ../../README.md
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Frame, PeerId, Snapshot } from "../../../../contracts";
import type { SessionApi } from "../../../session/types";
import { createSyncEngine } from "../../engine";
import { createSyncState } from "../../state";
import type { Config } from "../../types";

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeWire() {
  const handlers: Array<(peerId: PeerId, frame: Frame) => void> = [];

  return {
    send: vi.fn<(peerId: PeerId, frame: Frame) => void>(),
    broadcast: vi.fn<(frame: Frame) => void>(),
    on: vi.fn<(handler: (peerId: PeerId, frame: Frame) => void) => () => void>(handler => {
      handlers.push(handler);
      return () => {
        const idx = handlers.indexOf(handler);
        if (idx !== -1) {
          handlers.splice(idx, 1);
        }
      };
    }),
    // Test helper: simulate an inbound frame arriving
    _deliver(peerId: PeerId, frame: Frame): void {
      for (const handler of handlers) {
        handler(peerId, frame);
      }
    }
  };
}

function makeSession(): SessionApi {
  return {
    createRoom: vi.fn(),
    qr: vi.fn(async () => null),
    joinRoom: vi.fn(),
    leave: vi.fn(),
    rejoin: vi.fn(),
    roster: vi.fn(() => []),
    self: vi.fn(() => ({ selfId: "host", role: "host" as const, roomCode: "ABC123" })),
    hostId: vi.fn(() => "host"),
    persistSnapshot: vi.fn(),
    recoveryPhase: vi.fn(() => "stable" as const)
  };
}

function makeConfig(overrides?: Partial<Config>): Config {
  return {
    broadcastHz: 30,
    skipEmptyDeltas: true,
    maxOpsPerDelta: 512,
    resyncOnGap: true,
    ...overrides
  };
}

function makeEngine(configOverrides?: Partial<Config>) {
  const state = createSyncState();
  const config = makeConfig(configOverrides);
  const wire = makeWire();
  const session = makeSession();
  const emit = vi.fn();

  const engine = createSyncEngine(state, config, wire, session, emit);
  engine.init();

  return { engine, state, config, wire, session, emit };
}

// ─────────────────────────────────────────────────────────────────────────────
// Slice registry
// ─────────────────────────────────────────────────────────────────────────────

describe("engine", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("registerSlice is idempotent for the same initial; throws on a conflicting initial", () => {
    const { engine } = makeEngine();

    // Idempotent: same initial is a no-op
    engine.registerSlice("scores", { p1: 0, p2: 0 });
    expect(() => engine.registerSlice("scores", { p1: 0, p2: 0 })).not.toThrow();

    // Conflicting initial: throws
    expect(() => engine.registerSlice("scores", { p1: 99 })).toThrow(/already registered/);
  });

  it("mutate marks the namespace dirty; the dirty flag clears after a tick", () => {
    const { engine, state, wire } = makeEngine({ skipEmptyDeltas: false });

    engine.registerSlice("scores", { p1: 0 });
    engine.startBroadcast();

    engine.mutate("scores", s => ({ ...s, p1: 10 }));
    expect(state.dirty).toHaveProperty("scores");

    // Advance one tick at 30 Hz = ~33ms
    vi.advanceTimersByTime(34);

    // Dirty should be cleared after tick
    expect(state.dirty).not.toHaveProperty("scores");
    expect(wire.broadcast).toHaveBeenCalled();

    engine.stopBroadcast();
  });

  it("sSeq increments per non-empty tick and stamps deltas/snapshots", () => {
    const { engine, state, wire } = makeEngine();

    engine.registerSlice("scores", { p1: 0 });
    engine.startBroadcast();

    expect(state.sSeq).toBe(0);

    engine.mutate("scores", s => ({ ...s, p1: 1 }));
    vi.advanceTimersByTime(34);

    expect(state.sSeq).toBe(1);

    const broadcastArg = wire.broadcast.mock.calls[0]?.[0];
    expect(broadcastArg).toMatchObject({ t: "sync-delta", sSeq: 1 });

    engine.stopBroadcast();
  });

  it("throttle coalesces N mutates within one tick into exactly one SyncDeltaFrame", () => {
    const { engine, wire } = makeEngine();

    engine.registerSlice("scores", { p1: 0, p2: 0 });
    engine.startBroadcast();

    // Multiple mutates in the same tick
    engine.mutate("scores", s => ({ ...s, p1: 1 }));
    engine.mutate("scores", s => ({ ...s, p1: 2 }));
    engine.mutate("scores", s => ({ ...s, p2: 5 }));

    // Only one broadcast frame after the tick fires
    vi.advanceTimersByTime(34);

    expect(wire.broadcast).toHaveBeenCalledTimes(1);
    const frame = wire.broadcast.mock.calls[0]?.[0];
    expect(frame).toMatchObject({ t: "sync-delta" });

    engine.stopBroadcast();
  });

  it("skipEmptyDeltas: an empty tick produces no broadcast", () => {
    const { engine, wire } = makeEngine({ skipEmptyDeltas: true });

    engine.registerSlice("scores", { p1: 0 });
    engine.startBroadcast();

    // No mutates — tick fires but no broadcast should occur
    vi.advanceTimersByTime(34);

    expect(wire.broadcast).not.toHaveBeenCalled();

    engine.stopBroadcast();
  });

  it("gap (incoming.sSeq > local.sSeq + 1) sets stale, ignores the delta", () => {
    const { engine, state } = makeEngine();

    // Local sSeq is 0; incoming with sSeq=5 is a gap
    engine.applyFrame({ t: "sync-delta", ops: [{ ns: "scores", key: "p1", val: 99 }], sSeq: 5 });

    expect(state.stale).toBe(true);
    // The delta should NOT have been applied
    expect(state.sSeq).toBe(0);
  });

  it("onResyncRequest fires on a gap when resyncOnGap is true", () => {
    const { engine } = makeEngine({ resyncOnGap: true });

    const handler = vi.fn();
    engine.onResyncRequest(handler);

    // Trigger a gap
    engine.applyFrame({ t: "sync-delta", ops: [], sSeq: 5 });

    // Handler should have been called (with "" since applyFrame doesn't have peerId context)
    expect(handler).toHaveBeenCalled();
  });

  it("subscribe fires on apply and once immediately when the namespace is present", () => {
    const { engine } = makeEngine();

    engine.registerSlice("scores", { p1: 0 });

    const cb = vi.fn();

    // Subscribe after registerSlice — should fire immediately with current value
    engine.subscribe("scores", cb);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith({ p1: 0 });

    // Applying a delta should also fire the subscriber
    engine.applyFrame({
      t: "sync-delta",
      ops: [{ ns: "scores", key: "p1", val: 10 }],
      sSeq: 1
    });
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb).toHaveBeenLastCalledWith({ p1: 10 });
  });

  it("subscribe does NOT fire immediately when namespace is not yet present", () => {
    const { engine } = makeEngine();

    const cb = vi.fn();
    engine.subscribe("scores", cb);

    expect(cb).not.toHaveBeenCalled();
  });

  it("subscribe unsubscribe function stops future notifications", () => {
    const { engine } = makeEngine();

    engine.registerSlice("scores", { p1: 0 });

    const cb = vi.fn();
    const off = engine.subscribe("scores", cb);

    // First immediate fire
    expect(cb).toHaveBeenCalledTimes(1);

    off(); // Unsubscribe

    // Applying a delta should NOT fire anymore
    engine.applyFrame({
      t: "sync-delta",
      ops: [{ ns: "scores", key: "p1", val: 99 }],
      sSeq: 1
    });
    expect(cb).toHaveBeenCalledTimes(1); // Still just the initial call
  });

  it("read returns a frozen copy, not a live reference (spec/11 §2.4)", () => {
    const { engine } = makeEngine();

    engine.registerSlice("scores", { p1: 0 });
    const cells = engine.read("scores");

    expect(cells).toBeDefined();
    expect(Object.isFrozen(cells)).toBe(true);

    // Attempting to mutate a frozen object should throw in strict mode
    // Use a non-null safe pattern (cells is asserted defined above)
    if (!cells) throw new Error("cells must be defined");
    const localCells = cells;
    expect(() => {
      (localCells as Record<string, unknown>).p1 = 99;
    }).toThrow();
  });

  it("read returns undefined for an unregistered namespace", () => {
    const { engine } = makeEngine();

    expect(engine.read("nonexistent")).toBeUndefined();
  });

  it("room:sync-ready is emitted exactly once on the ready transition", () => {
    const { engine, emit } = makeEngine();

    // Not ready yet
    expect(emit).not.toHaveBeenCalled();

    // First registerSlice marks ready on host
    engine.registerSlice("scores", { p1: 0 });
    expect(emit).toHaveBeenCalledTimes(1);

    // Second registerSlice must NOT re-emit
    engine.registerSlice("round", { n: 1 });
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("room:sync-ready fires on the first applied sync-snap (controller path)", () => {
    const { engine, emit } = makeEngine();

    expect(emit).not.toHaveBeenCalled();

    engine.applyFrame({
      t: "sync-snap",
      snapshot: { scores: { p1: 10 } },
      sSeq: 1
    });

    expect(emit).toHaveBeenCalledTimes(1);

    // Second snapshot must NOT re-emit
    engine.applyFrame({
      t: "sync-snap",
      snapshot: { scores: { p1: 20 } },
      sSeq: 2
    });
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("sendBaselineSnapshot sends a SyncSnapshotFrame to one peer via wire.send", () => {
    const { engine, wire } = makeEngine();

    engine.registerSlice("scores", { p1: 0 });
    engine.sendBaselineSnapshot("peer-1");

    expect(wire.send).toHaveBeenCalledTimes(1);
    const firstCall = wire.send.mock.calls[0];
    if (!firstCall) throw new Error("expected wire.send to have been called");
    const [peerId, frame] = firstCall;
    expect(peerId).toBe("peer-1");
    expect(frame).toMatchObject({ t: "sync-snap", snapshot: { scores: { p1: 0 } } });
  });

  it("sendBaselineSnapshot is a no-op when no slices are registered", () => {
    const { engine, wire } = makeEngine();

    engine.sendBaselineSnapshot("peer-1");

    expect(wire.send).not.toHaveBeenCalled();
  });

  it("broadcast(peerId) sends a SyncSnapshotFrame to one peer; broadcast() sends a delta", () => {
    const { engine, wire } = makeEngine();

    engine.registerSlice("scores", { p1: 0 });
    engine.mutate("scores", s => ({ ...s, p1: 5 }));

    // Full snapshot to one peer
    engine.broadcast("peer-1");
    expect(wire.send).toHaveBeenCalledTimes(1);
    expect(wire.send.mock.calls[0]?.[1]).toMatchObject({ t: "sync-snap" });

    // Delta to everyone
    engine.mutate("scores", s => ({ ...s, p1: 10 }));
    engine.broadcast();
    expect(wire.broadcast).toHaveBeenCalledTimes(1);
    expect(wire.broadcast.mock.calls[0]?.[0]).toMatchObject({ t: "sync-delta" });
  });

  it("startBroadcast is idempotent — calling twice does not create a second timer", () => {
    const { engine, state } = makeEngine();

    engine.registerSlice("scores", { p1: 0 });
    engine.startBroadcast();
    const handle1 = state.throttleHandle;

    engine.startBroadcast(); // second call — must be a no-op
    const handle2 = state.throttleHandle;

    expect(handle1).toBe(handle2);
    expect(state.broadcasting).toBe(true);

    engine.stopBroadcast();
  });

  it("stopBroadcast clears the timer and sets broadcasting to false", () => {
    const { engine, state } = makeEngine();

    engine.registerSlice("scores", { p1: 0 });
    engine.startBroadcast();

    expect(state.broadcasting).toBe(true);
    expect(state.throttleHandle).not.toBeNull();

    engine.stopBroadcast();

    expect(state.broadcasting).toBe(false);
    expect(state.throttleHandle).toBeNull();
  });

  it("sync-snap applied to controller clears stale and restores all namespaces", () => {
    const { engine, state } = makeEngine();

    // Force stale state
    state.stale = true;
    state.sSeq = 0;

    engine.applyFrame({
      t: "sync-snap",
      snapshot: { scores: { p1: 10, p2: 5 } },
      sSeq: 5
    });

    expect(state.stale).toBe(false);
    expect(state.sSeq).toBe(5);
    expect(engine.read("scores")).toEqual({ p1: 10, p2: 5 });
  });

  it("init throws on broadcastHz out of [5, 60] range", () => {
    const state = createSyncState();
    const config = makeConfig({ broadcastHz: 3 });
    const wire = makeWire();
    const session = makeSession();
    const engine = createSyncEngine(state, config, wire, session, vi.fn());

    expect(() => engine.init()).toThrow(/broadcastHz must be between 5 and 60/);
  });

  it("init throws on negative maxOpsPerDelta", () => {
    const state = createSyncState();
    const config = makeConfig({ maxOpsPerDelta: -1 });
    const wire = makeWire();
    const session = makeSession();
    const engine = createSyncEngine(state, config, wire, session, vi.fn());

    expect(() => engine.init()).toThrow(/maxOpsPerDelta must be >= 0/);
  });

  it("mutate on an unregistered namespace throws", () => {
    const { engine } = makeEngine();

    expect(() => engine.mutate("unregistered", s => s)).toThrow(/not registered/);
  });

  it("exportSnapshot returns a plain-JSON-stable snapshot and sSeq", () => {
    const { engine, state } = makeEngine();

    engine.registerSlice("scores", { p1: 5 });
    state.sSeq = 3;

    const { snapshot, sSeq } = engine.exportSnapshot();

    expect(sSeq).toBe(3);
    expect(snapshot).toEqual({ scores: { p1: 5 } });

    // Must be JSON-stable
    const json = JSON.stringify({ snapshot, sSeq });
    expect(JSON.parse(json)).toEqual({ snapshot, sSeq });
  });

  it("importSnapshot restores sSeq, marks namespaces registered, flips ready", () => {
    const { engine, state } = makeEngine();

    expect(state.ready).toBe(false);

    engine.importSnapshot({ scores: { p1: 10 } }, 7);

    expect(state.sSeq).toBe(7);
    expect(state.ready).toBe(true);
    expect(engine.read("scores")).toEqual({ p1: 10 });
  });

  it("isReady reflects the ready state", () => {
    const { engine } = makeEngine();

    expect(engine.isReady()).toBe(false);

    engine.registerSlice("scores", { p1: 0 });

    expect(engine.isReady()).toBe(true);
  });

  it("session.persistSnapshot is called after a broadcast tick", () => {
    const { engine, session } = makeEngine();

    engine.registerSlice("scores", { p1: 0 });
    engine.startBroadcast();

    engine.mutate("scores", s => ({ ...s, p1: 1 }));
    vi.advanceTimersByTime(34);

    expect(session.persistSnapshot).toHaveBeenCalledTimes(1);

    engine.stopBroadcast();
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // broadcastDirty edge branches: empty heartbeat delta, maxOpsPerDelta batching
  // ─────────────────────────────────────────────────────────────────────────────

  it("skipEmptyDeltas:false sends an empty heartbeat delta, bumps sSeq, and persists", () => {
    const { engine, state, wire, session } = makeEngine({ skipEmptyDeltas: false });

    engine.registerSlice("scores", { p1: 0 });
    engine.startBroadcast();

    expect(state.sSeq).toBe(0);

    // No mutates this tick — with skipEmptyDeltas off, an empty delta is still emitted.
    vi.advanceTimersByTime(34);

    expect(state.sSeq).toBe(1);
    expect(wire.broadcast).toHaveBeenCalledTimes(1);
    expect(wire.broadcast.mock.calls[0]?.[0]).toEqual({ t: "sync-delta", ops: [], sSeq: 1 });
    expect(session.persistSnapshot).toHaveBeenCalledTimes(1);

    engine.stopBroadcast();
  });

  it("maxOpsPerDelta>0 splits a large dirty set into multiple delta frames", () => {
    // maxOpsPerDelta=2 with 5 changed cells → ceil(5/2) = 3 delta frames, sSeq bumped once per frame.
    const { engine, state, wire } = makeEngine({ maxOpsPerDelta: 2 });

    engine.registerSlice("scores", { a: 0, b: 0, c: 0, d: 0, e: 0 });
    engine.mutate("scores", () => ({ a: 1, b: 1, c: 1, d: 1, e: 1 }));

    engine.broadcast(); // delta to everyone

    expect(wire.broadcast).toHaveBeenCalledTimes(3);
    // Each frame carries at most maxOpsPerDelta ops.
    for (const call of wire.broadcast.mock.calls) {
      const frame = call[0];
      expect(frame.t).toBe("sync-delta");
      if (frame.t !== "sync-delta") throw new Error("expected a sync-delta frame");
      expect(frame.ops.length).toBeLessThanOrEqual(2);
    }
    // sSeq advanced once per emitted frame.
    expect(state.sSeq).toBe(3);
  });

  it("maxOpsPerDelta:0 falls back to a single delta carrying all ops", () => {
    // The `maxOpsPerDelta > 0 ? ... : allOps.length` ternary takes the else branch when the cap is 0.
    const { engine, state, wire } = makeEngine({ maxOpsPerDelta: 0 });

    engine.registerSlice("scores", { a: 0, b: 0, c: 0 });
    engine.mutate("scores", () => ({ a: 1, b: 1, c: 1 }));

    engine.broadcast();

    expect(wire.broadcast).toHaveBeenCalledTimes(1);
    const frame = wire.broadcast.mock.calls[0]?.[0];
    if (frame?.t !== "sync-delta") throw new Error("expected a sync-delta frame");
    expect(frame.ops).toHaveLength(3);
    expect(state.sSeq).toBe(1);
  });

  it("broadcast() with nothing dirty and skipEmptyDeltas on is a no-op", () => {
    const { engine, wire, state } = makeEngine({ skipEmptyDeltas: true });

    engine.registerSlice("scores", { p1: 0 });
    // No mutate → dirty set empty.
    engine.broadcast();

    expect(wire.broadcast).not.toHaveBeenCalled();
    expect(state.sSeq).toBe(0);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // applyDeltaFrame: stale short-circuit, duplicate/idempotent sSeq
  // ─────────────────────────────────────────────────────────────────────────────

  it("a delta arriving while stale is dropped (awaiting a fresh snapshot)", () => {
    const { engine, state } = makeEngine();

    // Force a gap so the replica is stale.
    engine.applyFrame({ t: "sync-delta", ops: [{ ns: "scores", key: "p1", val: 1 }], sSeq: 5 });
    expect(state.stale).toBe(true);
    expect(state.sSeq).toBe(0);

    // A subsequent (even contiguous-looking) delta is ignored entirely while stale.
    engine.applyFrame({ t: "sync-delta", ops: [{ ns: "scores", key: "p1", val: 2 }], sSeq: 1 });
    expect(state.sSeq).toBe(0);
    expect(engine.read("scores")).toBeUndefined();
  });

  it("a duplicate/already-applied delta (sSeq <= local sSeq) is an idempotent no-op", () => {
    const { engine, state } = makeEngine();

    engine.applyFrame({ t: "sync-delta", ops: [{ ns: "scores", key: "p1", val: 10 }], sSeq: 1 });
    expect(state.sSeq).toBe(1);
    expect(engine.read("scores")).toEqual({ p1: 10 });

    // Re-deliver the SAME sSeq — must not re-apply (idempotent).
    engine.applyFrame({ t: "sync-delta", ops: [{ ns: "scores", key: "p1", val: 999 }], sSeq: 1 });
    expect(state.sSeq).toBe(1);
    expect(engine.read("scores")).toEqual({ p1: 10 });

    // An older sSeq is likewise ignored.
    engine.applyFrame({ t: "sync-delta", ops: [{ ns: "scores", key: "p1", val: 7 }], sSeq: 0 });
    expect(engine.read("scores")).toEqual({ p1: 10 });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Inbound wire route (init): only sync-snap/sync-delta reach applyFrame
  // ─────────────────────────────────────────────────────────────────────────────

  it("the inbound wire handler routes sync-snap and sync-delta into the engine", () => {
    const { engine, wire, state } = makeEngine();

    // A sync-snap delivered through the wire (init wired the handler) re-baselines the replica.
    wire._deliver("host_root", { t: "sync-snap", snapshot: { scores: { p1: 3 } }, sSeq: 4 });
    expect(state.sSeq).toBe(4);
    expect(engine.read("scores")).toEqual({ p1: 3 });

    // A sync-delta through the wire applies contiguously.
    wire._deliver("host_root", {
      t: "sync-delta",
      ops: [{ ns: "scores", key: "p1", val: 9 }],
      sSeq: 5
    });
    expect(state.sSeq).toBe(5);
    expect(engine.read("scores")).toEqual({ p1: 9 });
  });

  it("the inbound wire handler ignores non-sync frames (e.g. ping)", () => {
    const { wire, state } = makeEngine();

    // A non-sync frame must not touch engine state (the handler's `t` guard is false).
    wire._deliver("host_root", { t: "ping", ts: 123 });
    expect(state.sSeq).toBe(0);
    expect(state.ready).toBe(false);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // mutate no-op, unsubscribe of resync handler, stopBroadcast idempotence
  // ─────────────────────────────────────────────────────────────────────────────

  it("mutate that produces a deep-equal value does NOT mark the namespace dirty", () => {
    const { engine, state } = makeEngine();

    engine.registerSlice("scores", { p1: 0 });

    // Recipe returns an equal-but-new object — JSON-equal, so no dirty flag and no snapshot swap.
    const before = state.snapshot;
    engine.mutate("scores", () => ({ p1: 0 }));

    expect(state.dirty).not.toHaveProperty("scores");
    expect(state.snapshot).toBe(before); // snapshot reference unchanged
  });

  it("onResyncRequest unsubscribe removes the handler so a later gap no longer fires it", () => {
    const { engine } = makeEngine({ resyncOnGap: true });

    const handler = vi.fn();
    const off = engine.onResyncRequest(handler);

    // First gap fires the handler.
    engine.applyFrame({ t: "sync-delta", ops: [], sSeq: 5 });
    expect(handler).toHaveBeenCalledTimes(1);

    // Unsubscribe, then a fresh snapshot clears stale so a new gap can be detected again.
    off();
    engine.applyFrame({ t: "sync-snap", snapshot: { scores: { p1: 0 } }, sSeq: 6 });
    engine.applyFrame({ t: "sync-delta", ops: [], sSeq: 20 });

    // The handler was removed — still only the single original call.
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("a gap with resyncOnGap:false sets stale WITHOUT firing resync handlers", () => {
    const { engine, state } = makeEngine({ resyncOnGap: false });

    const handler = vi.fn();
    engine.onResyncRequest(handler);

    engine.applyFrame({ t: "sync-delta", ops: [], sSeq: 5 });

    expect(state.stale).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });

  it("stopBroadcast is an idempotent no-op when broadcasting was never started", () => {
    const { engine, state } = makeEngine();

    expect(state.broadcasting).toBe(false);
    expect(state.throttleHandle).toBeNull();

    // Must hit the early-return guard and not throw.
    expect(() => engine.stopBroadcast()).not.toThrow();
    expect(state.broadcasting).toBe(false);
    expect(state.throttleHandle).toBeNull();
  });

  it("importSnapshot skips namespaces that are already registered", () => {
    const { engine } = makeEngine();

    // Pre-register `scores` so importSnapshot must NOT re-register it (the `!registered.has` branch).
    engine.registerSlice("scores", { p1: 0 });

    // Import a snapshot covering the already-registered `scores` plus a new `round`.
    engine.importSnapshot({ scores: { p1: 50 }, round: { n: 2 } }, 9);

    // Both namespaces are now readable; the import overwrote the snapshot and adopted sSeq.
    expect(engine.read("scores")).toEqual({ p1: 50 });
    expect(engine.read("round")).toEqual({ n: 2 });

    // `scores` was already registered, so a conflicting re-register still throws (it was not clobbered).
    expect(() => engine.registerSlice("round", { n: 0 })).toThrow(/already registered/);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Remaining defensive / edge branches
  // ─────────────────────────────────────────────────────────────────────────────

  it("broadcastDirty contributes no ops (and no frame) for a dirty namespace absent from the snapshot", () => {
    const { engine, state, wire, session } = makeEngine({ skipEmptyDeltas: false });

    engine.registerSlice("scores", { p1: 1 });
    // Mark a namespace dirty that has NO snapshot entry — the flatMap `!cells` guard returns [].
    state.dirty = { ghost: true };

    engine.broadcast();

    // dirtyNs is non-empty (skips the heartbeat path) but allOps is empty, so the batching loop never
    // runs: no delta frame is broadcast and sSeq is not bumped. persistSnapshot still runs once.
    expect(wire.broadcast).not.toHaveBeenCalled();
    expect(state.sSeq).toBe(0);
    expect(session.persistSnapshot).toHaveBeenCalledTimes(1);
    // The dirty flag is cleared regardless.
    expect(state.dirty).not.toHaveProperty("ghost");
  });

  it("mutate on a registered namespace whose snapshot cells are absent uses the {} fallback", () => {
    const { engine, state } = makeEngine();

    engine.registerSlice("scores", { p1: 0 });
    // Drop the snapshot entry while keeping the ns registered — mutate must fall back to `{}`.
    state.snapshot = {};

    engine.mutate("scores", draft => ({ ...draft, fresh: 1 }));

    expect(engine.read("scores")).toEqual({ fresh: 1 });
    expect(state.dirty).toHaveProperty("scores");
  });

  it("applyDeltaFrame skips notifying a namespace that a delete removed from the snapshot", () => {
    const { engine, state } = makeEngine();

    // Seed a single cell at sSeq 1.
    engine.applyFrame({ t: "sync-delta", ops: [{ ns: "scores", key: "p1", val: 1 }], sSeq: 1 });

    const cb = vi.fn();
    engine.subscribe("scores", cb);
    cb.mockClear();

    // Delete the only cell — `scores` becomes empty and is dropped from the snapshot, so the affected-ns
    // loop hits `if (cells)` false and skips notification for that (now-absent) namespace.
    engine.applyFrame({ t: "sync-delta", ops: [{ ns: "scores", key: "p1", val: null }], sSeq: 2 });

    expect(state.sSeq).toBe(2);
    expect(engine.read("scores")).toBeUndefined();
    expect(cb).not.toHaveBeenCalled();
  });

  it("applySnapshotFrame skips a namespace whose cells are absent in the decoded snapshot", () => {
    const { engine, state } = makeEngine();

    const cb = vi.fn();
    engine.subscribe("ghost", cb);

    // A snapshot key mapping to `undefined` decodes to an absent-cells entry → `if (cells)` false.
    const snapshot = { scores: { p1: 1 }, ghost: undefined } as unknown as Snapshot;
    engine.applyFrame({ t: "sync-snap", snapshot, sSeq: 3 });

    expect(state.sSeq).toBe(3);
    expect(engine.read("scores")).toEqual({ p1: 1 });
    expect(cb).not.toHaveBeenCalled(); // ghost had no cells, so its subscriber never fired
  });

  it("applyFrame ignores a frame that is neither sync-snap nor sync-delta", () => {
    const { engine, state } = makeEngine();

    // Directly hand applyFrame a non-sync frame — both `t` guards are false, nothing happens.
    engine.applyFrame({ t: "ping", ts: 1 });

    expect(state.sSeq).toBe(0);
    expect(state.ready).toBe(false);
  });

  it("a second subscribe to the same namespace reuses the existing subscriber list", () => {
    const { engine } = makeEngine();

    engine.registerSlice("scores", { p1: 0 });

    const a = vi.fn();
    const b = vi.fn();
    engine.subscribe("scores", a); // creates the list
    engine.subscribe("scores", b); // reuses it — the `!subscribers.has(ns)` guard is false

    a.mockClear();
    b.mockClear();

    engine.applyFrame({ t: "sync-delta", ops: [{ ns: "scores", key: "p1", val: 5 }], sSeq: 1 });

    expect(a).toHaveBeenCalledWith({ p1: 5 });
    expect(b).toHaveBeenCalledWith({ p1: 5 });
  });

  it("calling a subscribe unsubscribe twice is a safe no-op the second time", () => {
    const { engine } = makeEngine();

    engine.registerSlice("scores", { p1: 0 });
    const off = engine.subscribe("scores", vi.fn());

    off();
    // Second call — the handler is already gone, so `index !== -1` is false. Must not throw.
    expect(() => off()).not.toThrow();
  });

  it("calling an onResyncRequest unsubscribe twice is a safe no-op the second time", () => {
    const { engine } = makeEngine();

    const off = engine.onResyncRequest(vi.fn());

    off();
    // Second call hits the `index !== -1` false branch — idempotent, no throw.
    expect(() => off()).not.toThrow();
  });

  it("stopBroadcast clears the broadcasting flag even if the throttle handle is already null", () => {
    const { engine, state } = makeEngine();

    // Inconsistent state: marked broadcasting but with no live timer handle.
    state.broadcasting = true;
    state.throttleHandle = null;

    engine.stopBroadcast();

    expect(state.broadcasting).toBe(false);
    expect(state.throttleHandle).toBeNull();
  });
});
