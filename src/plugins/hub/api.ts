/**
 * @file hub plugin — API factory: `handle` (the sole worker fetch handler) over the native Cloudflare
 * `env` bindings. Non-WS requests fall through to the static-assets binding; a `Upgrade: websocket` is
 * rate-limited per IP (D24) then forwarded to the per-room Durable Object. No `endpoint()` routes —
 * default endpoint only, one WS protocol (D21). Takes the destructured {@link HubDeps} (the `index.ts`
 * harness passes `ctx.config`), so this module never touches the raw `ctx` (D14).
 * @see ./hub-do
 * @see .planning/specs/07-hub.md §API
 */
import type { Api, HubDeps } from "./types";

/**
 * Derives the room code from the request: the first path segment (`/{code}`, how `serverSignaling`
 * connects) or a `?room=` query fallback. Empty when neither is present.
 *
 * @param request - The inbound request.
 * @returns The room code, or `""` when none is present.
 * @example
 * ```ts
 * roomCodeOf(new Request("wss://host/K7M2QX")); // "K7M2QX"
 * ```
 */
function roomCodeOf(request: Request): string {
  const url = new URL(request.url);
  const firstSegment = url.pathname.slice(1).split("/")[0] ?? "";
  return firstSegment || (url.searchParams.get("room") ?? "");
}

/**
 * Creates the hub API: `handle` (WS→DO / else→ASSETS, rate-limited), reaching the Durable Object, KV, and
 * static-assets through the per-request native Cloudflare `env` bindings keyed by {@link HubDeps.config}.
 *
 * @param deps - The destructured per-app config bundle.
 * @returns The hub API mounted at `app.hub`.
 * @example
 * ```ts
 * const api = createApi({ config });
 * export default { fetch: (r, env, x) => api.handle(r, env, x) };
 * ```
 */
export function createApi(deps: HubDeps): Api {
  const { config } = deps;

  return {
    /** @inheritdoc */
    async handle(request, env, _exec): Promise<Response> {
      // 1. Not a WS upgrade → serve the built web client from the static-assets binding.
      if (request.headers.get("Upgrade") !== "websocket") {
        const assets = env[config.assetsBinding] as Fetcher;
        return assets.fetch(request);
      }

      // 2. WS upgrade needs a room code (the per-DO key).
      const code = roomCodeOf(request);
      if (!code) return new Response(null, { status: 400 });

      // 3. Per-IP join rate-limit (D24): a KV counter with a sliding TTL window.
      const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
      const key = `ratelimit:${ip}`;
      const kv = env[config.rateLimit.kvBinding] as KVNamespace;
      const count = Number(await kv.get(key)) || 0;
      if (count >= config.rateLimit.joins) return new Response(null, { status: 429 });
      await kv.put(key, String(count + 1), { expirationTtl: config.rateLimit.windowSec });

      // 4. Forward the upgrade to the per-room DO (one DO per code).
      const hub = env[config.doBinding] as DurableObjectNamespace;
      return hub.getByName(code).fetch(request);
    }
  };
}
