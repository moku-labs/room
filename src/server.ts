/**
 * @file `@moku-labs/room/server` — the server CORE (Step 2, spec/04 §4). Calls `createCore` on the shared
 * `coreConfig` with the opt-in `hubPlugin`, and EXPORTS the bound `createApp` + `createPlugin` plus the
 * `Hub` Durable Object class. The framework NEVER calls `createApp` and exports NO `fetch` handler — a
 * Layer-3 Cloudflare app composes `createApp`, exports `{ fetch }` from its own `cloudflare/worker.ts`,
 * re-exports `Hub` for the wrangler binding, and owns its `wrangler.jsonc` (D1/D26). The `hub` reaches the
 * DO + KV + ASSETS through the native Cloudflare `env` threaded into `app.hub.handle` — no `@moku-labs/worker`.
 * @see ./config
 * @see ./plugins/hub
 */
import { coreConfig, createCore } from "./config";
import { hubPlugin } from "./plugins/hub";

export { hubPlugin } from "./plugins/hub";
export { Hub } from "./plugins/hub/hub-do";

const core = createCore(coreConfig, {
  plugins: [hubPlugin]
});

/**
 * Create and initialize a `@moku-labs/room` server app — the Layer-3 entry point for the Cloudflare worker.
 * The `hub` is wired by default; `app.hub.handle(request, env, ctx)` is the request handler a consumer's
 * `cloudflare/worker.ts` delegates its `fetch` to.
 *
 * @param options - `plugins` (extra/custom), `pluginConfigs` (e.g. `hub` binding-name overrides),
 *   `config`, and lifecycle callbacks.
 * @returns The initialized app: `start()`, `stop()`, `app.hub`, and `log`.
 * @example
 * ```ts
 * // your-app/src/server.ts — the ROOT composition file: create the app once, export it.
 * import { createApp } from "@moku-labs/room/server";
 * export const app = createApp();
 *
 * // your-app/src/cloudflare/worker.ts — the Cloudflare entry: USE the composed app to wire the Worker.
 * import { app } from "../server";
 * export { Hub } from "@moku-labs/room/server"; // wrangler binds ROOM_HUB → Hub
 * export default {
 *   fetch: (req: Request, env: Record<string, unknown>, ctx: ExecutionContext) =>
 *     app.hub.handle(req, env, ctx)
 * } satisfies ExportedHandler;
 * ```
 */
export const createApp = core.createApp;

/**
 * Create a custom plugin bound to Room's `Config`/`Events` + core APIs (server side). Types infer from the
 * spec object — never written explicitly. Pass the result to {@link createApp} via `plugins`.
 *
 * @example
 * ```ts
 * const audit = createPlugin("audit", { api: (ctx) => ({ note: (m: string) => ctx.log.info("audit", { m }) }) });
 * ```
 */
export const createPlugin = core.createPlugin;
