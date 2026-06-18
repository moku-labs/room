/**
 * Unit tests for the per-app `SyncEngine` (`engine.ts`): slice registry, dirty-flag, sSeq monotonicity,
 * throttle coalescing (fake timers at `broadcastHz`), gap detection, subscription firing, frozen reads,
 * and the single `room:sync-ready` emit. Transport `Wire` mocked (`broadcast`/`send`/`on` as `vi.fn()`).
 *
 * @file
 * @see ../../README.md
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Frame, PeerId } from "../../../../contracts";
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
});
