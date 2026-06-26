/**
 * Standard tier — hub: DO-per-room signaling/discovery/recovery hub wiring (D21/D25). A room-core plugin
 * (`createPlugin` from `../../config`); it reaches the Durable Object + rate-limit KV + static assets
 * through the native Cloudflare `env` threaded into `handle` (no `@moku-labs/worker` plugin dependencies).
 *
 * @see README.md
 */
import { createPlugin } from "../../config";
import { createApi } from "./api";
import { defaultConfig } from "./config";
import { createState } from "./state";

/* eslint-disable jsdoc/require-jsdoc -- structural wiring callback; domain JSDoc lives in api/types */
/**
 * `hubPlugin` — Room's opt-in operated signaling tier (Standard tier). Owns the per-room `Hub` Durable
 * Object + rate-limit KV config and a thin `handle` that routes `Upgrade: websocket` → the per-room `Hub`
 * DO and everything else → the static-assets binding. Composed into the `./server` core's `createApp`; the
 * `Hub` DO class is co-located (NOT a plugin — D6/I3) and re-exported from `src/server.ts`.
 *
 * @see README.md
 */
export const hubPlugin = createPlugin("hub", {
  config: defaultConfig,
  createState,
  api: ctx => createApi({ config: ctx.config })
});
/* eslint-enable jsdoc/require-jsdoc */
