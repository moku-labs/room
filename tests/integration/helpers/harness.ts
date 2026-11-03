/**
 * @file Shared composition harness for the framework-level `tests/integration/` suite.
 *
 * Distinct from the colocated per-plugin integration tests (`src/plugins/*\/__tests__/integration/`):
 * those import individual plugin instances; THIS harness composes the **public** pre-bundled arrays
 * (`[stagePlugin]` / `[controllerPlugin]`) through `@moku-labs/web`'s `createApp`, exactly as a
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

import { vi } from "vitest";
import type { RoomEvents } from "../../../src/config";
import {
  controllerPlugin,
  createApp,
  createPlugin,
  inMemory,
  stagePlugin
} from "../../../src/index";

/** A live in-process signaling bus (the `inMemory()` adapter return type). */
export type Bus = ReturnType<typeof inMemory>;

/** One captured `room:*` lifecycle event observed by a consumer probe plugin. */
export type CapturedEvent = { name: keyof RoomEvents; payload: unknown };

/** The heartbeat timings a test shortens, so a lost peer is declared dead in milliseconds. */
export type HeartbeatTimings = { heartbeatIntervalMs: number; heartbeatTimeoutMs: number };

/**
 * A fresh, isolated in-process signaling bus. Create ONE per test and pass the SAME instance to every
 * app that must rendezvous (two `inMemory()` calls are two disjoint buses and will never connect).
 */
export function makeBus(): Bus {
  return inMemory();
}

/**
 * A fresh, isolated in-process signaling bus in **server mode** (`inMemory({ server: true })`) — the
 * deterministic stand-in for the opt-in `serverSignaling` Worker tier. Its sessions are `persistent: true`
 * and simulate the contracts §1.3 server protocol (join / peer-arrived / relay / reclaim / evict), so the
 * server-tier opt-in is exercisable through the public `roomPlugins` arrays without a live Durable Object.
 * Like {@link makeBus}, pass the SAME instance to every app that must rendezvous.
 *
 * Note: the server-mode bus omits the transport-internal loopback capability, so it brokers signaling only
 * (no in-process `WireChannel` pair) — the channel-establishment assertions in this suite use {@link makeBus}.
 */
export function makeServerBus(): Bus {
  return inMemory({ server: true });
}

/**
 * Shared `pluginConfigs` for every Room app in the harness: the required `site` block (web's core
 * plugin), the in-memory `signaling` bus on transport, and the `session.generateQr` toggle. QR is OFF
 * by default (the DOM-free test bus has no camera path); pass `generateQr: true` to exercise the public
 * `session.qr()` / `stage.qr()` accessor (the encoder is pure and DOM-free, so it runs under the bus too).
 *
 * @param bus - The in-process signaling bus to wire onto transport.
 * @param generateQr - Whether `session` should build QR matrix data. Default `false`.
 * @param heartbeat - Heartbeat timings for transport. Default: the transport's own.
 * @param reconnectTimeoutMs - The session's reconnect window. Default: the session's own.
 * @returns The `pluginConfigs` object to hand to `createApp`.
 */
export function siteCfg(
  bus: Bus,
  generateQr = false,
  heartbeat?: HeartbeatTimings,
  reconnectTimeoutMs?: number
) {
  return {
    transport: { signaling: bus, ...heartbeat },
    session: { generateQr, ...(reconnectTimeoutMs === undefined ? {} : { reconnectTimeoutMs }) }
  };
}

/**
 * Replaces `localStorage` with a `Map`, so a reload's re-entry record survives from one `createApp` to the
 * next. Undo it with `vi.unstubAllGlobals()`.
 *
 * @returns The `Map` behind the stub.
 */
export function stubLocalStorage(): Map<string, string> {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    get length(): number {
      return store.size;
    },
    key: (index: number): string | null => [...store.keys()][index] ?? null,
    getItem: (key: string): string | null => store.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      store.set(key, value);
    },
    removeItem: (key: string): void => {
      store.delete(key);
    }
  });
  return store;
}

/**
 * The six-hook `room:*` capture map shared by both role probes. Every observed lifecycle event is
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
    "room:host-back": (p: RoomEvents["room:host-back"]): void => {
      captured.push({ name: "room:host-back", payload: p });
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
 * Builds a STAGE (host / shared-screen) app from the public `[stagePlugin]` plus a throwaway game
 * probe that `depends:[stagePlugin]` and records every `room:*` event it sees (the WARN-2 visibility
 * proof). The returned app exposes `app.stage`, `app.sync`, `app.session`, `app.intent`, `app.transport`.
 * Pass `generateQr: true` to exercise the host's public `stage.qr()` accessor.
 *
 * @param bus - The in-process signaling bus to rendezvous on.
 * @param probeName - Unique plugin name for the event-capture probe (avoid collisions across apps).
 * @param generateQr - Whether `session` should build QR matrix data (drives `stage.qr()`). Default `false`.
 * @returns `{ app, captured }` — the composed host app and its captured `room:*` events.
 */
export function makeStage(bus: Bus, probeName = "stageGameProbe", generateQr = false) {
  const captured: CapturedEvent[] = [];

  const probe = createPlugin(probeName, {
    depends: [stagePlugin],
    createState: (): Record<string, never> => ({}),
    api: (): Record<string, never> => ({}),
    hooks: captureHooks(captured)
  });

  const app = createApp({
    plugins: [stagePlugin, probe],
    pluginConfigs: siteCfg(bus, generateQr)
  });

  return { app, captured };
}

/**
 * Builds a CONTROLLER (phone) app from the public `[controllerPlugin]` plus a throwaway game probe
 * that `depends:[controllerPlugin]` and records every `room:*` event it sees. The returned app exposes
 * `app.controller`, `app.sync`, `app.session`, `app.intent`, `app.transport`. Give each controller a
 * unique `probeName` so multi-controller composition does not collide on plugin names. Pass `heartbeat` when
 * the test needs a lost host declared dead in milliseconds, and `reconnectTimeoutMs` when it needs a join to
 * time out in milliseconds.
 */
export function makeController(
  bus: Bus,
  probeName: string,
  heartbeat?: HeartbeatTimings,
  reconnectTimeoutMs?: number
) {
  const captured: CapturedEvent[] = [];

  const probe = createPlugin(probeName, {
    depends: [controllerPlugin],
    createState: (): Record<string, never> => ({}),
    api: (): Record<string, never> => ({}),
    hooks: captureHooks(captured)
  });

  const app = createApp({
    plugins: [controllerPlugin, probe],
    pluginConfigs: siteCfg(bus, false, heartbeat, reconnectTimeoutMs)
  });

  return { app, captured };
}

/** `true` iff a `room:*` event with `name` was captured by the probe. */
export function sawEvent(captured: CapturedEvent[], name: keyof RoomEvents): boolean {
  return captured.some(e => e.name === name);
}

/** How many `room:*` events with `name` the probe captured. */
export function countEvent(captured: CapturedEvent[], name: keyof RoomEvents): number {
  return captured.filter(e => e.name === name).length;
}
