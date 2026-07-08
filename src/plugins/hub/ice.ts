/**
 * @file hub plugin — the worker-side `GET /api/ice` credential endpoint. Mints short-lived TURN
 * relay credentials from Cloudflare's Realtime TURN service when the deployment carries the TURN
 * secrets (`TURN_KEY_ID`/`TURN_KEY_API_TOKEN` — provisioned by `@moku-labs/worker`'s `turnPlugin`
 * when the app declares one, or bound by hand via `wrangler secret put`),
 * rate-limited per-IP through the hub's existing rate-limit KV. Without secrets (local dev, an
 * un-provisioned stage) it answers a quiet empty `200 {}` and the transport's default provider
 * fails open onto its STUN default — the endpoint is an upgrade, never a dependency. Pure +
 * injectable (structural env slices, injectable fetch) so it unit-tests without a worker.
 * @see ../transport/ice-shared
 */

import type { IceServer } from "../transport/ice-shared";
import { ICE_CREDENTIAL_TTL_SECONDS, normalizeIceServers } from "../transport/ice-shared";
import type { Config } from "./types";

/** Cloudflare TURN credential API root (Realtime TURN service). */
const CF_TURN_BASE = "https://rtc.live.cloudflare.com/v1/turn/keys";

/**
 * The slice of a Cloudflare `KVNamespace` the rate limiter touches (structural, so unit tests pass
 * a plain in-memory map and this module never depends on generated worker types).
 */
export type IceRateLimitKv = {
  /**
   * Read a counter cell.
   *
   * @param key - The cell key.
   * @returns The stored value, or null.
   */
  get(key: string): Promise<string | null>;
  /**
   * Write a counter cell with a TTL.
   *
   * @param key - The cell key.
   * @param value - The value to store.
   * @param options - KV write options.
   * @param options.expirationTtl - Cell TTL in seconds (KV minimum is 60).
   * @returns Resolves once written.
   */
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
};

/**
 * Build a small JSON response with credential-appropriate caching (never store).
 *
 * @param status - HTTP status.
 * @param body - JSON-serializable body.
 * @returns The response.
 * @example
 * ```ts
 * json(429, { error: "rate-limited" });
 * ```
 */
function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/**
 * Count this IP against the mint budget: read-increment a TTL'd KV cell, deny past the cap. The
 * read-then-write is not atomic — fine for abuse damping (the TTL on minted credentials is the real
 * bound), not billing-grade quota.
 *
 * @param kv - The rate-limit KV.
 * @param ip - The caller's IP (or the shared `"unknown"` bucket when the header is absent).
 * @param limit - The per-window mint cap + window length.
 * @param limit.max - Max mints inside one window.
 * @param limit.windowSec - Window length in seconds (KV's minimum TTL is 60).
 * @returns `true` when the request is within budget.
 * @example
 * ```ts
 * if (!(await allowRequest(kv, ip, { max: 30, windowSec: 60 }))) return json(429, {});
 * ```
 */
async function allowRequest(
  kv: IceRateLimitKv,
  ip: string,
  limit: { max: number; windowSec: number }
): Promise<boolean> {
  const key = `ice:${ip}`;
  const seen = Number((await kv.get(key)) ?? "0");
  if (seen >= limit.max) return false;
  await kv.put(key, String(seen + 1), { expirationTtl: limit.windowSec });
  return true;
}

/**
 * Mint one short-lived credential set from Cloudflare's TURN API and normalize its body (Cloudflare
 * returns a single `RTCIceServer`-shaped object under `iceServers`).
 *
 * @param keyId - The TURN key id.
 * @param apiToken - The TURN key API token.
 * @param fetchImpl - Injectable fetch (tests).
 * @returns The validated servers, or `undefined` on any upstream failure.
 * @example
 * ```ts
 * const servers = await mintFromCloudflare(keyId, apiToken, fetch);
 * ```
 */
async function mintFromCloudflare(
  keyId: string,
  apiToken: string,
  fetchImpl: typeof fetch
): Promise<readonly IceServer[] | undefined> {
  try {
    const response = await fetchImpl(`${CF_TURN_BASE}/${keyId}/credentials/generate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl: ICE_CREDENTIAL_TTL_SECONDS })
    });
    if (!response.ok) return undefined;

    const body = (await response.json()) as { iceServers?: unknown } | null;
    return normalizeIceServers(body?.iceServers);
  } catch {
    return undefined;
  }
}

/**
 * Handle `GET /api/ice`: rate-limit, mint TURN credentials, answer `{ iceServers }`. No secrets is
 * NOT a failure — it answers a quiet, empty `200 {}` (every local dev boot; a non-2xx here would
 * paint a red console line on every TV + phone load for expected behaviour). Real failures keep
 * loud, distinct statuses the fail-open client treats identically (STUN fallback): 405 wrong
 * method, 429 over budget, 502 upstream mint failure.
 *
 * @param request - The incoming request (IP read from `CF-Connecting-IP`).
 * @param env - The per-invocation worker bindings (secrets + rate-limit KV read by configured name).
 * @param config - The hub config (secret binding names + the ice rate-limit knobs).
 * @param fetchImpl - Injectable fetch (tests); defaults to the global.
 * @returns The JSON response.
 * @example
 * ```ts
 * if (url.pathname === config.ice.path) return handleIce(request, env, config);
 * ```
 */
export async function handleIce(
  request: Request,
  env: Record<string, unknown>,
  config: Config,
  fetchImpl: typeof fetch = fetch
): Promise<Response> {
  if (request.method !== "GET") return json(405, { error: "method-not-allowed" });

  // No TURN secrets on this deployment → the rung simply isn't provisioned. Answer an empty 200
  // (expected state, not an error — a 5xx would console-spam every local dev boot); the transport's
  // default provider normalizes the missing field to its STUN fallback.
  const keyId = env[config.ice.keyIdBinding];
  const apiToken = env[config.ice.apiTokenBinding];
  if (
    typeof keyId !== "string" ||
    keyId === "" ||
    typeof apiToken !== "string" ||
    apiToken === ""
  ) {
    return json(200, {});
  }

  // Damp abuse per-IP before spending an upstream call (strangers farming relay credentials).
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const kv = env[config.rateLimit.kvBinding] as IceRateLimitKv | undefined;
  if (kv && !(await allowRequest(kv, ip, config.ice.rateLimit))) {
    return json(429, { error: "rate-limited" });
  }

  const iceServers = await mintFromCloudflare(keyId, apiToken, fetchImpl);
  if (!iceServers) return json(502, { error: "mint-failed" });
  return json(200, { iceServers });
}
