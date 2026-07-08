/**
 * @file hub plugin — type definitions (Config, State, Api). The client↔DO protocol
 * (`ClientEnvelope`/`ServerEnvelope`/`SignalMsg`/`PeerId`/`MAX_CONTROLLERS`) lives in
 * `../transport/protocol` (the DOM-free wire/signaling contract), imported by the DO + adapter.
 * @see ./api
 * @see ./hub-do
 */

/**
 * The per-invocation Cloudflare Worker env — the consuming app's bindings, indexed by the configured
 * names (`doBinding` → `DurableObjectNamespace`, `rateLimit.kvBinding` → `KVNamespace`, `assetsBinding` →
 * `Fetcher`). Threaded into {@link Api.handle}; never stored.
 */
export type HubEnvironment = Record<string, unknown>;

/** hub plugin configuration (see `.planning/specs/07-hub.md` §Config). */
export type Config = {
  /** The Durable Object binding name for the per-room hub (env var; consumer `wrangler.jsonc`). */
  readonly doBinding: string;
  /** The exported `Hub` Durable Object class name (consumer wrangler `migrations`). */
  readonly doClassName: string;
  /** The static-assets binding that serves the built web client (`env.ASSETS`). */
  readonly assetsBinding: string;
  /** Per-IP join rate-limit: max `joins` within `windowSec`, counted in the `kvBinding` KV (D24). */
  readonly rateLimit: {
    readonly joins: number;
    readonly windowSec: number;
    readonly kvBinding: string;
  };
  /**
   * The `/api/ice` TURN-credential endpoint: `handle` answers `GET {path}` by minting short-lived
   * relay credentials from Cloudflare's Realtime TURN service using the two worker secrets bound at
   * `keyIdBinding`/`apiTokenBinding` (provisioned by `@moku-labs/worker`'s `turnPlugin` when the
   * app declares one — see the README's Internet play section). Without
   * the secrets it answers a quiet empty `200 {}` (fail-open: the transport keeps its STUN default).
   * `rateLimit` is the per-IP mint budget inside one window (counted in the same `rateLimit.kvBinding` KV).
   */
  readonly ice: {
    readonly path: string;
    readonly keyIdBinding: string;
    readonly apiTokenBinding: string;
    readonly rateLimit: { readonly max: number; readonly windowSec: number };
  };
  /** Reject a `join` arriving more than this many ms after the socket opened (join-window guard, D24). */
  readonly joinWindowMs: number;
  /** Idle TTL before the DO Alarm tears the room down (only fires at 0 live sockets). */
  readonly roomTtlMs: number;
};

/** hub holds no cross-request state (env is threaded per call). */
export type State = Record<string, never>;

/** hub public API surface (mounted at `app.hub`). */
export type Api = {
  /**
   * The sole worker fetch handler: routes `Upgrade: websocket` to the per-room `Hub` Durable Object (after
   * the per-IP rate-limit check) via the native Cloudflare `env` bindings, and every other request to
   * `env[assetsBinding].fetch` (the built web client). No HTTP/REST endpoints (D21 — one WS protocol).
   *
   * @param request - The inbound Cloudflare `Request`.
   * @param env - The per-invocation Worker env (the consumer's bindings; threaded, never stored).
   * @param exec - The Cloudflare `ExecutionContext`.
   * @returns The DO's `101` upgrade response, an ASSETS response, or `429`/`400` on a guard trip.
   * @example
   * ```ts
   * export default { fetch: (r, env, ctx) => app.hub.handle(r, env, ctx) };
   * ```
   */
  handle(request: Request, env: HubEnvironment, exec: ExecutionContext): Promise<Response>;
};

/**
 * The destructured per-app pieces `createApi` consumes (D14 — never the raw `ctx`). Just the resolved
 * config; the Cloudflare resources are reached through the per-request `env` in {@link Api.handle}.
 */
export type HubDeps = {
  /** This app's frozen, resolved hub config. */
  readonly config: Config;
};
