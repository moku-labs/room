/**
 * @file room-hub plugin — API factory: `handle` (the sole worker fetch handler) + `deployManifest`.
 *
 * `handle` keeps the entry thin (logic lives here, moku-idioms I4): non-WS requests fall through to the
 * static-assets binding; a `Upgrade: websocket` is rate-limited per IP (D24) then forwarded to the
 * per-room Durable Object. No `endpoint()` routes — default endpoint only, one WS protocol (D21).
 *
 * Takes the destructured {@link RoomHubDeps} bundle (the `index.ts` harness resolves each dependency via
 * `ctx.require(...)`), so this module never touches the raw `ctx` (D14, mirrors `session`).
 * @see ./room-hub-do
 * @see .planning/specs/07-room-hub.md §API
 */
import type { Api, RoomHubDeps } from "./types";

/**
 * The `durableObjects` config key for the per-room hub (matches `server.ts`'s
 * `pluginConfigs.durableObjects.roomHub`). Distinct from the env binding (`config.doBinding`): the key
 * selects the configured instance, `getByName(code)` addresses one DO per room code.
 */
const DO_LOGICAL_NAME = "roomHub";

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
 * Creates the room-hub API: `handle` (WS→DO / else→ASSETS, rate-limited) + `deployManifest`. Closes over
 * the resolved dependency APIs + config from {@link RoomHubDeps}.
 *
 * @param deps - The destructured per-app pieces (`config` + resolved `durableObjects`/`kv`/`bindings`).
 * @returns The room-hub API mounted at `app.roomHub`.
 * @example
 * ```ts
 * const api = createApi({ config, durableObjects, kv, bindings });
 * export default { fetch: (r, env, x) => api.handle(r, env, x) };
 * ```
 */
export function createApi(deps: RoomHubDeps): Api {
  const { config, durableObjects, kv, bindings } = deps;

  return {
    /** @inheritdoc */
    async handle(request, env, _exec): Promise<Response> {
      // 1. Not a WS upgrade → serve the built web client from the static-assets binding.
      if (request.headers.get("Upgrade") !== "websocket") {
        const assets = bindings.require<Fetcher>(env, config.assetsBinding);
        return assets.fetch(request);
      }

      // 2. WS upgrade needs a room code (the per-DO key).
      const code = roomCodeOf(request);
      if (!code) return new Response(null, { status: 400 });

      // 3. Per-IP join rate-limit (D24): a KV counter with a sliding TTL window.
      const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
      const key = `ratelimit:${ip}`;
      const count = Number(await kv.get(env, key)) || 0;
      if (count >= config.rateLimit.joins) return new Response(null, { status: 429 });
      await kv.put(env, key, String(count + 1), { expirationTtl: config.rateLimit.windowSec });

      // 4. Forward the upgrade to the per-room DO (one DO per code).
      const stub = durableObjects.get(env, DO_LOGICAL_NAME, code);
      return stub.fetch(request);
    },

    /** @inheritdoc */
    deployManifest() {
      return [...durableObjects.deployManifest(), ...kv.deployManifest()];
    }
  };
}
