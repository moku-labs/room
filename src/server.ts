/**
 * @file Room worker (Cloudflare) server-app entry — `@moku-labs/room/server` (D21/D22/D26).
 * Exports the composed `app` + default `{ fetch }` (deployable as-is) and re-exports the reusable
 * `roomHubPlugin` / `RoomHub` for consumers who compose their own app. The CONSUMING APP owns
 * deployment config (`wrangler.jsonc`: ROOM_HUB / RATE_LIMIT / ASSETS bindings + `main`).
 */
import type { WorkerEnv } from "@moku-labs/worker";
import { createApp, durableObjectsPlugin, kvPlugin } from "@moku-labs/worker";
import { roomHubPlugin } from "./plugins/room-hub";

export { roomHubPlugin } from "./plugins/room-hub";
export { RoomHub } from "./plugins/room-hub/room-hub-do";

/**
 * The composed Room worker app — `durableObjects` + `kv` + `roomHub` on `@moku-labs/worker`. Deployable
 * as-is via the default `{ fetch }` export below, or re-composed by a consumer around this instance
 * (spec/07 §Overview). Safe to export despite the inferred type referencing non-exported
 * `@moku-labs/core` internals: the `./server` tsdown entry is JS-only (`dts: false`), so that inferred
 * type never reaches a published `.d.ts`.
 *
 * @example
 * ```ts
 * import { app } from "@moku-labs/room/server";
 * export default { fetch: (req, env, ctx) => app.roomHub.handle(req, env, ctx) };
 * ```
 */
export const app = createApp({
  config: { name: "room-hub", compatibilityDate: "2026-06-17" },
  plugins: [durableObjectsPlugin, kvPlugin, roomHubPlugin],
  pluginConfigs: {
    durableObjects: { roomHub: { binding: "ROOM_HUB", className: "RoomHub" } },
    kv: { rateLimit: { name: "room-rate-limit", binding: "RATE_LIMIT" } }
  }
});

export default {
  /**
   * Cloudflare fetch entry — delegates every request to the room-hub plugin's `handle`.
   *
   * @param request - The inbound Cloudflare Request.
   * @param env - The per-invocation Worker env.
   * @param ctx - The Cloudflare execution context.
   * @returns The room-hub response (DO upgrade, ASSETS, or a guard response).
   * @example
   * ```ts
   * export default { fetch };
   * ```
   */
  fetch: (request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> =>
    app.roomHub.handle(request, env, ctx)
} satisfies ExportedHandler<WorkerEnv>;
