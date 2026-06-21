/**
 * @file room-hub plugin — type definitions (Config, State, Api) + the api-factory context.
 *
 * The client↔DO protocol (`ClientEnvelope`/`ServerEnvelope`/`SignalMsg`/`PeerId`/`MAX_CONTROLLERS`) is
 * defined ONCE in `../../contracts` (D16/D23) and imported by the DO + adapter — never re-declared here.
 * @see ./api
 * @see ./room-hub-do
 */
import type {
  bindingsPlugin,
  durableObjectsPlugin,
  kvPlugin,
  ResourceManifest,
  WorkerEnv
} from "@moku-labs/worker";

/** room-hub plugin configuration (see `.planning/specs/07-room-hub.md` §Config). */
export type Config = {
  /** The Durable Object binding name for the per-room hub (env var; consumer wrangler.jsonc). */
  readonly doBinding: string;
  /** The exported `RoomHub` Durable Object class name (consumer wrangler `migrations`). */
  readonly doClassName: string;
  /** The static-assets binding that serves the built web client (`env.ASSETS`). */
  readonly assetsBinding: string;
  /** Per-IP join rate-limit: max `joins` within `windowSec`, counted in the `kvBinding` KV (D24). */
  readonly rateLimit: {
    readonly joins: number;
    readonly windowSec: number;
    readonly kvBinding: string;
  };
  /** Reject a `join` arriving more than this many ms after the socket opened (join-window guard, D24). */
  readonly joinWindowMs: number;
  /** Idle TTL before the DO Alarm tears the room down (only fires at 0 live sockets). */
  readonly roomTtlMs: number;
};

/** room-hub holds no cross-request state (env is threaded per call). */
export type State = Record<string, never>;

/** room-hub public API surface (mounted at `app.roomHub`). */
export type Api = {
  /**
   * The sole worker fetch handler: routes `Upgrade: websocket` to the per-room DO (after the per-IP
   * rate-limit check) and every other request to `env.ASSETS.fetch` (the built web client). No
   * HTTP/REST endpoints (D21 — default endpoint only, one WS protocol).
   *
   * @param request - The inbound Cloudflare `Request`.
   * @param env - The per-invocation Worker env (threaded, never stored).
   * @param exec - The Cloudflare `ExecutionContext`.
   * @returns The DO's `101` upgrade response, an ASSETS response, or `429`/`400` on a guard trip.
   * @example
   * ```ts
   * export default { fetch: (r, env, ctx) => app.roomHub.handle(r, env, ctx) };
   * ```
   */
  handle(request: Request, env: WorkerEnv, exec: ExecutionContext): Promise<Response>;

  /**
   * Returns this plugin's deploy descriptors (the per-room DO + the rate-limit KV) for
   * `@moku-labs/worker`'s deploy pipeline — read by the CONSUMER's deploy step to assemble their
   * `wrangler.jsonc`. One descriptor per resource instance.
   *
   * @returns Resource manifest descriptors for the room-hub's DO + rate-limit KV.
   */
  deployManifest(): ResourceManifest[];
};

/**
 * Extracts a plugin instance's public API type via its phantom `_phantom.api` slot — the same extraction
 * core's `ExtractPluginApi` performs, so a value from `ctx.require(plugin)` is assignable to it without
 * re-declaring any dependency's API (KV in particular exports no public `Api` namespace).
 */
type ApiOf<P> = P extends { readonly _phantom: { readonly api: infer A } } ? A : never;

/**
 * The destructured per-app pieces `createApi` consumes (D14 — never the raw `ctx`, mirroring `session`'s
 * `makeSessionDeps`). The `index.ts` wiring harness resolves each dependency via `ctx.require(...)` — where
 * the inferred context types it correctly — and passes the resolved APIs here, so this module never
 * re-types the generic `require` (whose overload form collapses to `unknown` under assignment).
 */
export type RoomHubDeps = {
  /** This app's frozen, resolved room-hub config. */
  readonly config: Config;
  /** The resolved `durableObjects` API (per-room stub resolution + deploy manifest). */
  readonly durableObjects: ApiOf<typeof durableObjectsPlugin>;
  /** The resolved `kv` API (the per-IP rate-limit counter + deploy manifest). */
  readonly kv: ApiOf<typeof kvPlugin>;
  /** The resolved `bindings` API (the static-assets binding resolver). */
  readonly bindings: ApiOf<typeof bindingsPlugin>;
};
