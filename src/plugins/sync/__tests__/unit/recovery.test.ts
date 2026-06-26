/**
 * Unit tests for the persistence seam (`exportSnapshot`/`importSnapshot`) — the bytes `sessionPlugin`
 * persists for host-reload recovery (00-contracts §5).
 *
 * @file
 * @see ../../README.md
 */
import { describe, expect, it, vi } from "vitest";
import type { SessionApi } from "../../../session/types";
import type { Frame, PeerId } from "../../../transport/protocol";
import { createSyncEngine } from "../../engine";
import { createSyncState } from "../../state";
import type { Config } from "../../types";

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────────

// Stub wire.on implementation — returns a no-op unsubscribe function
const noopUnsubscribe = () => {};
const noopOnHandler = () => noopUnsubscribe;

function makeWire() {
  return {
    send: vi.fn<(peerId: PeerId, frame: Frame) => void>(),
    broadcast: vi.fn<(frame: Frame) => void>(),
    on: vi.fn<(handler: (peerId: PeerId, frame: Frame) => void) => () => void>(noopOnHandler)
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

function makeEngine(configOverrides?: Partial<Config>) {
  const state = createSyncState();
  const config: Config = {
    broadcastHz: 30,
    skipEmptyDeltas: true,
    maxOpsPerDelta: 512,
    resyncOnGap: true,
    ...configOverrides
  };
  const wire = makeWire();
  const session = makeSession();
  const emit = vi.fn();

  const engine = createSyncEngine(state, config, wire, session, emit);
  engine.init();

  return { engine, state, wire, session, emit };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("recovery seam", () => {
  it("exportSnapshot output is JSON.parse(JSON.stringify(x))-stable", () => {
    const { engine } = makeEngine();

    engine.registerSlice("scores", { p1: 5, p2: 3 });
    engine.registerSlice("round", { n: 2, phase: "playing" });

    const exported = engine.exportSnapshot();
    const json = JSON.stringify(exported);
    const parsed = JSON.parse(json) as typeof exported;

    expect(parsed).toEqual(exported);
  });

  it("importSnapshot(snap, sSeq) restores sSeq and marks namespaces registered", () => {
    const { engine, state } = makeEngine();

    engine.importSnapshot({ scores: { p1: 10, p2: 5 } }, 42);

    expect(state.sSeq).toBe(42);
    // Namespace should be readable after import
    expect(engine.read("scores")).toEqual({ p1: 10, p2: 5 });
  });

  it("importSnapshot flips ready to true", () => {
    const { engine, state } = makeEngine();

    expect(state.ready).toBe(false);

    engine.importSnapshot({ scores: { p1: 10 } }, 1);

    expect(state.ready).toBe(true);
  });

  it("a host broadcast(peerId) after import re-baselines the peer (00-contracts §5)", () => {
    const { engine, wire } = makeEngine();

    engine.importSnapshot({ scores: { p1: 10 } }, 5);

    // Now send a full snapshot to a peer (simulating re-entry reconcile)
    engine.broadcast("peer-1");

    expect(wire.send).toHaveBeenCalledTimes(1);
    const firstCall = wire.send.mock.calls[0];
    if (!firstCall) throw new Error("expected wire.send to have been called");
    const [peerId, frame] = firstCall;
    expect(peerId).toBe("peer-1");
    expect(frame).toMatchObject({
      t: "sync-snap",
      snapshot: { scores: { p1: 10 } }
    });
  });

  it("exportSnapshot → importSnapshot round-trip preserves all namespace data", () => {
    const { engine } = makeEngine();

    engine.registerSlice("scores", { p1: 100, p2: 50 });
    engine.registerSlice("round", { n: 5, phase: "finale" });

    // Capture current state
    const { snapshot, sSeq } = engine.exportSnapshot();

    // Create a fresh engine to simulate re-entry
    const { engine: engine2 } = makeEngine();
    engine2.importSnapshot(snapshot, sSeq);

    expect(engine2.read("scores")).toEqual({ p1: 100, p2: 50 });
    expect(engine2.read("round")).toEqual({ n: 5, phase: "finale" });
    expect(engine2.isReady()).toBe(true);
  });

  it("exportSnapshot returns copies, not live references (mutation safety)", () => {
    const { engine } = makeEngine();

    engine.registerSlice("scores", { p1: 0 });

    const { snapshot: snap1 } = engine.exportSnapshot();

    // Mutate via engine — exported snapshot must be unaffected
    engine.mutate("scores", s => ({ ...s, p1: 99 }));

    const { snapshot: snap2 } = engine.exportSnapshot();

    expect(snap1).toEqual({ scores: { p1: 0 } });
    expect(snap2).toEqual({ scores: { p1: 99 } });
  });
});
