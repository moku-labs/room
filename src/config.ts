/**
 * @file `@moku-labs/room` browser-side framework config — Step 1 of the factory chain (spec/04 §3).
 *
 * Room is its OWN Moku framework on `@moku-labs/core` — a sibling to `@moku-labs/web`/`@moku-labs/worker`,
 * NOT built on them. This file defines the browser `Config`/`Events` contract and registers the `log`/`env`
 * core plugins, then exports the bound `createPlugin` (every engine imports it) and `createCore` (the
 * `browser.ts` core calls it once). The framework NEVER calls `createApp` — it exports that factory from the
 * core; Layer-3 apps call it (spec/02 §3–4). The wire/signaling protocol lives in
 * `./plugins/transport/protocol`.
 * @see ./browser
 * @see ./plugins/transport/protocol
 */
import { envPlugin, logPlugin } from "@moku-labs/common";
import { createCoreConfig } from "@moku-labs/core";
import type { PeerId } from "./plugins/transport/protocol";

/** Browser-side global config. Minimal by design — every concrete setting is per-plugin (`pluginConfigs`). */
export type RoomConfig = Record<string, never>;

/**
 * Room's coarse lifecycle events on the Moku `emit` plane. Declared once here as the framework `Events`
 * contract; the owning engine registers each via the register-callback pattern (spec/14 §2), and facades
 * re-declare (never re-emit) them. These are the ONLY events Room emits — all device↔host traffic is the
 * wire protocol, never these.
 */
export type RoomEvents = {
  /** A controller's DataChannel reached `connected` and was added to the roster (§6). */
  "room:peer-joined": { peerId: PeerId };
  /** A controller left or was declared dead by the heartbeat (§2.4) and removed from the roster. */
  "room:peer-left": { peerId: PeerId };
  /** The host tab reloaded; recovery is in flight. Controllers should show "reconnecting" UX (§5). */
  "room:host-reconnecting": Record<string, never>;
  /** The first authoritative frame (snapshot, or gap-free delta) has been applied; replica readable (§4). */
  "room:sync-ready": Record<string, never>;
  /** A network condition surfaced to the consumer for failure UX (D2 accepted hard-failure). */
  "room:network-warning": {
    reason: "ice-failed" | "rendezvous-unreachable" | "channel-closed" | "room-evicted";
  };
};

/** Complete defaults for {@link RoomConfig} (empty — no global config; per-plugin config covers everything). */
const defaultConfig: RoomConfig = {};

/**
 * The framework's global `Events` map — intentionally EMPTY: each engine declares its own `room:*` slice
 * via the register callback (spec/14 §2), typed by {@link RoomEvents}. `Record<never, never>` (NOT
 * `Record<string, never>`) is deliberate — the latter's `[string]: never` index signature would merge
 * every plugin event payload down to `never`.
 */
type FrameworkEvents = Record<never, never>;

/**
 * Step 1 — the browser framework's `Config` contract plus the `log`/`env` core plugins (from
 * `@moku-labs/common`), so every engine's `ctx` has `ctx.log`/`ctx.env`. Framework `Events` is **empty**
 * (like `@moku-labs/web`): each engine declares its own `room:*` slice via the register callback, typed
 * by {@link RoomEvents}. Exports the bound `createPlugin` (engines import it) and `createCore` (the
 * `browser.ts` core calls it once).
 *
 * @example
 * ```ts
 * // an engine, in src/plugins/<name>/index.ts:
 * import { createPlugin } from "../../config";
 * export const fooPlugin = createPlugin("foo", { api: (ctx) => ({ ... }) });
 * ```
 */
export const coreConfig = createCoreConfig<
  RoomConfig,
  FrameworkEvents,
  [typeof logPlugin, typeof envPlugin]
>("room", {
  config: defaultConfig,
  plugins: [logPlugin, envPlugin]
});

export const { createPlugin, createCore } = coreConfig;
