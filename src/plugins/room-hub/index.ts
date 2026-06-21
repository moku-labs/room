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
export const roomHubPlugin = createPlugin("roomHub", {
  config: defaultConfig,
  depends: [durableObjectsPlugin, kvPlugin, bindingsPlugin],
  createState,
  api: createApi
});
