/**
 * @file room-hub plugin — API factory skeleton.
 */
import type { WorkerPluginCtx } from "@moku-labs/worker";
import type { Api, Config, State } from "./types";

/**
 * Creates the room-hub API: `handle` (WS→DO / else→ASSETS, rate-limited) + `deployManifest`.
 *
 * @param _ctx - The worker plugin context (`ctx.require`, `ctx.log`, `ctx.env`).
 * @throws {Error} Always in the skeleton — not implemented.
 * @example
 * ```ts
 * const api = createApi(ctx);
 * ```
 */
export function createApi(_ctx: WorkerPluginCtx<Config, State>): Api {
  throw new Error("not implemented");
}
