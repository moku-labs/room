/**
 * Standard tier — room-hub: DO-per-room signaling/discovery/recovery hub wiring (D21/D25).
 *
 * @see README.md
 */
import { bindingsPlugin, createPlugin, durableObjectsPlugin, kvPlugin } from "@moku-labs/worker";
import { createApi } from "./api";
import { defaultConfig } from "./config";
import { createState } from "./state";

// bindingsPlugin is a @moku-labs/worker framework default — listed in `depends` for ctx.require typing,
// NOT re-listed in createApp's `plugins` (defaults log/env/stage/bindings/server; duplicates throw).
// The api harness resolves each dependency here (where the inferred ctx types `require` correctly) and
// hands the resolved APIs to `createApi` as a destructured deps bundle (D14, mirrors `session`).
/* eslint-disable jsdoc/require-jsdoc -- structural wiring callback (the api harness); domain JSDoc lives in the extracted api/types modules */
/**
 * `roomHubPlugin` — Room's opt-in operated signaling tier (Standard tier, `@moku-labs/worker`). Owns the
 * `ROOM_HUB` DO + rate-limit KV config and a thin `handle` that routes `Upgrade: websocket` → the per-room
 * `RoomHub` Durable Object and everything else → `env.ASSETS`. Re-exported from `src/server.ts` for a
 * consumer composing their own `createApp`. The `RoomHub` DO is co-located (NOT a plugin — D6/I3).
 *
 * @see README.md
 */
export const roomHubPlugin = createPlugin("roomHub", {
  config: defaultConfig,
  depends: [durableObjectsPlugin, kvPlugin, bindingsPlugin],
  createState,
  api: ctx =>
    createApi({
      config: ctx.config,
      durableObjects: ctx.require(durableObjectsPlugin),
      kv: ctx.require(kvPlugin),
      bindings: ctx.require(bindingsPlugin)
    })
});
/* eslint-enable jsdoc/require-jsdoc */
