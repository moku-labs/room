/**
 * @file stage — integration tests (full wiring via createApp + inMemory signaling, D13/contracts §1.3).
 *
 * Composes [stagePlugin] + a throwaway game plugin (depends:[stagePlugin]) as the host.
 * No real RTCPeerConnection — purely in-memory signaling bus. Exercises the lifecycle,
 * room creation, forwarding proof, and mutate/broadcast with a registered sync slice.
 *
 * Simplification note: the full intent→mutate→controller-read round-trip requires the
 * controllerPlugin composition + a second app on the same bus. This is exercised in the
 * [controllerPlugin] integration test. Here we cover:
 * 1. createRoom() returns a RoomDescriptor synchronously (6-char code)
 * 2. lifecycle: start → stage methods → stop resolves cleanly
 * 3. room:sync-ready forwarding reaches a depends:[stagePlugin] game plugin (the WARN-2 proof)
 * 4. mutate + broadcast do not throw when a slice is registered
 * 5. stopping twice / stopping an un-started app surfaces engine behavior, not a facade error
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomEvents } from "../../../../config";
import { createApp, createPlugin } from "../../../../index";
import { inMemory } from "../../../transport/adapters/in-memory";
import { stagePlugin } from "../../index";

type Bus = ReturnType<typeof inMemory>;

/**
 * Builds a stage host app. The returned `captured` array receives every room:* event
 * that the gameProbe's hooks observe (proving WARN-2 forwarding).
 */
function makeStageApp(bus: Bus) {
  const captured: Array<{ name: string; payload: unknown }> = [];
  let syncReadyFired = false;

  // gameProbe: a throwaway plugin that depends on stagePlugin. Its hooks ONLY fire if the
  // facade has re-declared the five room:* events (WARN-2 — event visibility is not transitive).
  const gameProbe = createPlugin("gameProbe", {
    depends: [stagePlugin],
    createState: (): Record<string, never> => ({}),
    api: (): Record<string, never> => ({}),
    hooks: () => ({
      "room:peer-joined": (payload: RoomEvents["room:peer-joined"]) => {
        captured.push({ name: "room:peer-joined", payload });
      },
      "room:peer-left": (payload: RoomEvents["room:peer-left"]) => {
        captured.push({ name: "room:peer-left", payload });
      },
      "room:host-reconnecting": (payload: RoomEvents["room:host-reconnecting"]) => {
        captured.push({ name: "room:host-reconnecting", payload });
      },
      "room:sync-ready": (payload: RoomEvents["room:sync-ready"]) => {
        captured.push({ name: "room:sync-ready", payload });
        syncReadyFired = true;
      },
      "room:network-warning": (payload: RoomEvents["room:network-warning"]) => {
        captured.push({ name: "room:network-warning", payload });
      }
    })
  });

  const app = createApp({
    plugins: [stagePlugin, gameProbe],
    pluginConfigs: {
      transport: { signaling: bus },
      session: { generateQr: false }
    }
  });

  return { app, captured, isSyncReady: () => syncReadyFired };
}

describe("stage — createApp integration (inMemory signaling)", () => {
  let bus: Bus;

  beforeEach(() => {
    bus = inMemory();
  });

  afterEach(() => {
    // Each test manages its own app lifecycle — nothing to tear down globally.
  });

  it("await app.start() → app.stage.createRoom() returns a RoomDescriptor synchronously", async () => {
    const { app } = makeStageApp(bus);
    await app.start();

    const desc = app.stage.createRoom();

    expect(desc.code).toHaveLength(6);
    expect(desc.joinUrl).toContain("?room=");
    expect(desc.hostToken).toMatch(/^[\da-f-]{36}$/i);
    expect(desc.qr).toBeNull(); // generateQr: false

    await app.stop();
  });

  it("createApp → start → stage methods → stop completes cleanly; app.stop() resolves", async () => {
    const { app } = makeStageApp(bus);
    await app.start();

    app.stage.createRoom();
    // Facade methods complete synchronously without error
    expect(() => app.stage.roster()).not.toThrow();
    expect(() => app.stage.broadcast()).not.toThrow();
    const off = app.stage.onIntent("test", vi.fn());
    expect(typeof off).toBe("function");
    off();

    await expect(app.stop()).resolves.toBeUndefined();
  });

  it("mutate + broadcast complete without throwing when a sync slice is registered", async () => {
    const { app } = makeStageApp(bus);
    await app.start();

    // registerSlice must be called before mutate (sync throws if ns is unregistered)
    app.sync.registerSlice("scores", { p1: 0 });

    expect(() => {
      app.stage.mutate("scores", draft => ({ ...draft, p1: 1 }));
    }).not.toThrow();

    expect(() => {
      app.stage.broadcast();
    }).not.toThrow();

    await app.stop();
  });

  it("room:sync-ready forwarding end-to-end: the game plugin's hook fires after sync is ready", async () => {
    const { app, isSyncReady } = makeStageApp(bus);
    await app.start();

    // Register a slice and call createRoom to trigger the host path.
    // The host becomes sync-ready after registerSlice + startBroadcast (onStart of sync).
    app.sync.registerSlice("round", { n: 1 });
    app.stage.createRoom();

    // Trigger a broadcast to mark the sync snapshot as ready
    app.sync.broadcast();

    // Wait for room:sync-ready to propagate through the facade to gameProbe
    await vi.waitFor(
      () => {
        expect(isSyncReady()).toBe(true);
      },
      { timeout: 2000 }
    );

    await app.stop();
  });

  it("facade contributes no teardown work — stopping twice surfaces engine behavior, not a facade error", async () => {
    const { app } = makeStageApp(bus);
    await app.start();
    app.stage.createRoom();

    // First stop — engines tear down
    await expect(app.stop()).resolves.toBeUndefined();
    // Second stop — engines handle it; facade never throws from its own teardown (it has none)
    await expect(app.stop()).resolves.toBeUndefined();
  });

  it("roster() returns an empty array before any controllers join", async () => {
    const { app } = makeStageApp(bus);
    await app.start();

    app.stage.createRoom();
    const roster = app.stage.roster();

    expect(Array.isArray(roster)).toBe(true);
    expect(roster).toHaveLength(0);

    await app.stop();
  });
});
