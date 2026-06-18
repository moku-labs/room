/**
 * @file Shared composition harness for the framework-level `tests/integration/` suite.
 *
 * Distinct from the colocated per-plugin integration tests (`src/plugins/*\/__tests__/integration/`):
 * those import individual plugin instances; THIS harness composes the **public** pre-bundled arrays
 * (`roomPlugins.stage` / `roomPlugins.controller`) through `@moku-labs/web`'s `createApp`, exactly as a
 * consumer app would. The transport `signaling` is the deterministic `inMemory()` bus (DOM-free, no
 * `RTCPeerConnection`, contracts §1.3 / D13) so a stage device + N controller devices rendezvous
 * in-process and carry real `Frame`s end-to-end.
 *
 * Import note: the package self-import (`@moku-labs/room`) resolves to `./dist`, so tests import the
 * live surface via relative source (`../../../src/index`) — same code, no build step required.
 *
 * Async note: cross-app delivery rides a microtask pipe, so assertions on delivered state MUST use
 * `vi.waitFor(...)` rather than arbitrary sleeps.
 */

import { createApp, createPlugin } from "@moku-labs/web";
import type { RoomEvents } from "../../../src/contracts";
import { controllerPlugin, inMemory, roomPlugins, stagePlugin } from "../../../src/index";

/** A live in-process signaling bus (the `inMemory()` adapter return type). */
export type Bus = ReturnType<typeof inMemory>;

/** One captured `room:*` lifecycle event observed by a consumer probe plugin. */
export type CapturedEvent = { name: keyof RoomEvents; payload: unknown };

/**
 * A fresh, isolated in-process signaling bus. Create ONE per test and pass the SAME instance to every
 * app that must rendezvous (two `inMemory()` calls are two disjoint buses and will never connect).
 */
export function makeBus(): Bus {
  return inMemory();
}

/**
 * Shared `pluginConfigs` for every Room app in the harness: the required `site` block (web's core
 * plugin), the in-memory `signaling` bus on transport, and QR generation off (DOM-free test bus).
 */
export function siteCfg(bus: Bus) {
  return {
    site: { name: "room-test", url: "https://room.test" },
    transport: { signaling: bus },
    session: { generateQr: false }
  };
}

/**
 * The five-hook `room:*` capture map shared by both role probes. Every observed lifecycle event is
 * pushed onto `captured` so a test can assert which events reached a `depends:[facade]` consumer.
 */
function captureHooks(captured: CapturedEvent[]) {
  return () => ({
    "room:peer-joined": (p: RoomEvents["room:peer-joined"]): void => {
      captured.push({ name: "room:peer-joined", payload: p });
    },
    "room:peer-left": (p: RoomEvents["room:peer-left"]): void => {
      captured.push({ name: "room:peer-left", payload: p });
    },
    "room:host-reconnecting": (p: RoomEvents["room:host-reconnecting"]): void => {
      captured.push({ name: "room:host-reconnecting", payload: p });
    },
    "room:sync-ready": (p: RoomEvents["room:sync-ready"]): void => {
      captured.push({ name: "room:sync-ready", payload: p });
    },
    "room:network-warning": (p: RoomEvents["room:network-warning"]): void => {
      captured.push({ name: "room:network-warning", payload: p });
    }
  });
}

/**
 * Builds a STAGE (host / shared-screen) app from the public `roomPlugins.stage` plus a throwaway game
 * probe that `depends:[stagePlugin]` and records every `room:*` event it sees (the WARN-2 visibility
 * proof). The returned app exposes `app.stage`, `app.sync`, `app.session`, `app.intent`, `app.transport`.
 */
export function makeStage(bus: Bus, probeName = "stageGameProbe") {
  const captured: CapturedEvent[] = [];

  const probe = createPlugin(probeName, {
    depends: [stagePlugin],
    createState: (): Record<string, never> => ({}),
    api: (): Record<string, never> => ({}),
    hooks: captureHooks(captured)
  });

  const app = createApp({
    plugins: [...roomPlugins.stage, probe],
    pluginConfigs: siteCfg(bus)
  });

  return { app, captured };
}

/**
 * Builds a CONTROLLER (phone) app from the public `roomPlugins.controller` plus a throwaway game probe
 * that `depends:[controllerPlugin]` and records every `room:*` event it sees. The returned app exposes
 * `app.controller`, `app.sync`, `app.session`, `app.intent`, `app.transport`. Give each controller a
 * unique `probeName` so multi-controller composition does not collide on plugin names.
 */
export function makeController(bus: Bus, probeName: string) {
  const captured: CapturedEvent[] = [];

  const probe = createPlugin(probeName, {
    depends: [controllerPlugin],
    createState: (): Record<string, never> => ({}),
    api: (): Record<string, never> => ({}),
    hooks: captureHooks(captured)
  });

  const app = createApp({
    plugins: [...roomPlugins.controller, probe],
    pluginConfigs: siteCfg(bus)
  });

  return { app, captured };
}

/** `true` iff a `room:*` event with `name` was captured by the probe. */
export function sawEvent(captured: CapturedEvent[], name: keyof RoomEvents): boolean {
  return captured.some(e => e.name === name);
}
