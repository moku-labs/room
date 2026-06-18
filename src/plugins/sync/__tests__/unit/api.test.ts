/**
 * Unit tests for `createSyncApi` (`api.ts`): each method delegates to the engine and surfaces the
 * documented behavior. Engine verified via mocked wire + session.
 *
 * @file
 * @see ../../README.md
 */
import { describe, expect, it, vi } from "vitest";
import type { Frame, PeerId } from "../../../../contracts";
import type { SessionApi } from "../../../session/types";
import { createSyncApi } from "../../api";
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
    })
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

function makeApi(configOverrides?: Partial<Config>) {
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

  const api = createSyncApi(state, config, wire, session, emit);
  // Trigger init manually (in real plugin, index.ts calls engine.init() in onInit)
  state.engine?.init();

  return { api, state, wire, session, emit };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("createSyncApi", () => {
  it("state.engine is assigned after createSyncApi", () => {
    const { state } = makeApi();

    expect(state.engine).not.toBeNull();
  });

  it("mutate on an unregistered namespace throws", () => {
    const { api } = makeApi();

    expect(() => api.mutate("unregistered", s => s)).toThrow(/not registered/);
  });

  it("broadcast(peerId) sends a sync-snap to one peer; broadcast() sends a sync-delta to all", () => {
    const { api, wire } = makeApi();

    api.registerSlice("scores", { p1: 0 });
    api.mutate("scores", s => ({ ...s, p1: 5 }));

    // With peerId: sends a full snapshot to that peer
    api.broadcast("peer-1");
    expect(wire.send).toHaveBeenCalledTimes(1);
    expect(wire.send.mock.calls[0]?.[1]).toMatchObject({ t: "sync-snap" });

    // Without peerId: broadcasts a delta to everyone
    api.mutate("scores", s => ({ ...s, p1: 10 }));
    api.broadcast();
    expect(wire.broadcast).toHaveBeenCalledTimes(1);
    expect(wire.broadcast.mock.calls[0]?.[0]).toMatchObject({ t: "sync-delta" });
  });

  it("exportSnapshot then mutate then importSnapshot(prev) restores prior state", () => {
    const { api } = makeApi();

    api.registerSlice("scores", { p1: 0 });
    const { snapshot: snap1, sSeq: sSeq1 } = api.exportSnapshot();

    api.mutate("scores", s => ({ ...s, p1: 99 }));

    // Restore to the prior state
    api.importSnapshot(snap1, sSeq1);

    expect(api.read("scores")).toEqual({ p1: 0 });
  });

  it("isReady mirrors the engine ready flag", () => {
    const { api } = makeApi();

    expect(api.isReady()).toBe(false);

    api.registerSlice("scores", { p1: 0 });

    expect(api.isReady()).toBe(true);
  });

  it("every API method delegates to the matching engine method", () => {
    const { api, state } = makeApi();

    // Verify the engine is the same instance behind the API (assigned by createSyncApi)
    if (!state.engine) throw new Error("engine must be assigned by createSyncApi");
    const engine = state.engine;

    const spyRead = vi.spyOn(engine, "read");
    const spySubscribe = vi.spyOn(engine, "subscribe");
    const spyApplyFrame = vi.spyOn(engine, "applyFrame");
    const spyIsReady = vi.spyOn(engine, "isReady");
    const spyExport = vi.spyOn(engine, "exportSnapshot");
    const spyImport = vi.spyOn(engine, "importSnapshot");

    api.read("ns");
    api.subscribe("ns", vi.fn());
    api.applyFrame({ t: "sync-snap", snapshot: {}, sSeq: 1 });
    api.isReady();
    api.exportSnapshot();
    api.importSnapshot({}, 0);

    expect(spyRead).toHaveBeenCalled();
    expect(spySubscribe).toHaveBeenCalled();
    expect(spyApplyFrame).toHaveBeenCalled();
    expect(spyIsReady).toHaveBeenCalled();
    expect(spyExport).toHaveBeenCalled();
    expect(spyImport).toHaveBeenCalled();
  });

  it("onResyncRequest registers and returns an unsubscribe function", () => {
    const { api } = makeApi({ resyncOnGap: true });

    const handler = vi.fn();
    const off = api.onResyncRequest(handler);

    expect(typeof off).toBe("function");
    off(); // Should not throw
  });

  it("startBroadcast/stopBroadcast propagate to engine", () => {
    const { api, state } = makeApi();

    api.registerSlice("scores", { p1: 0 });

    api.startBroadcast();
    expect(state.broadcasting).toBe(true);
    expect(state.throttleHandle).not.toBeNull();

    api.stopBroadcast();
    expect(state.broadcasting).toBe(false);
    expect(state.throttleHandle).toBeNull();
  });

  it("read returns undefined for absent namespace", () => {
    const { api } = makeApi();

    expect(api.read("missing")).toBeUndefined();
  });

  it("subscribe fires immediately for existing namespace and returns unsubscribe", () => {
    const { api } = makeApi();

    api.registerSlice("scores", { p1: 0 });

    const cb = vi.fn();
    const off = api.subscribe("scores", cb);

    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith({ p1: 0 });
    expect(typeof off).toBe("function");
  });
});
