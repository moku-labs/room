/**
 * @file `@moku-labs/room/server` — the opt-in server tier. Exports the `hubPlugin` (a `@moku-labs/worker`
 * plugin) + the `Hub` Durable Object class. It is NOT a standalone server core (no `createCore`/`createApp`):
 * a Layer-3 Cloudflare app composes `hubPlugin` into its OWN `@moku-labs/worker` `createApp` — alongside
 * `durableObjectsPlugin` (the `Hub` DO) + `deployPlugin`/`cliPlugin` (wrangler generation) — keeping full
 * control of its worker composition + `wrangler.jsonc`, exactly like `demos/atlas` composes its plugins.
 * `app.hub.handle(request, env, ctx)` is the runtime fetch the app's `cloudflare/worker.ts` delegates to.
 * `@moku-labs/worker` is a PEER dependency the consuming app provides.
 * @example
 * ```ts
 * // your-app/src/server.ts — ONE worker app, atlas-style:
 * import { cliPlugin, createApp, deployPlugin, durableObjectsPlugin, kvPlugin } from "@moku-labs/worker";
 * import { hubPlugin } from "@moku-labs/room/server";
 * export const server = createApp({
 *   plugins: [kvPlugin, durableObjectsPlugin, hubPlugin, deployPlugin, cliPlugin],
 *   pluginConfigs: { durableObjects: { hub: { binding: "ROOM_HUB", className: "Hub" } } }
 * });
 *
 * // your-app/src/cloudflare/worker.ts:
 * import { server } from "../server";
 * export { Hub } from "@moku-labs/room/server"; // wrangler binds ROOM_HUB → Hub
 * export default {
 *   fetch: (req, env, ctx) => server.hub.handle(req, env, ctx)
 * } satisfies ExportedHandler;
 * ```
 * @see ./plugins/hub
 */
export { hubPlugin } from "./plugins/hub";
export { Hub } from "./plugins/hub/hub-do";
