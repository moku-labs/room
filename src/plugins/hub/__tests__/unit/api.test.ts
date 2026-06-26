/**
 * @file Unit tests for the hub plugin API (Cycle-2 W3): `handle` routing (non-WS → ASSETS, WS → per-room
 * DO, 429 over the rate limit, 400 without a code) over the native Cloudflare `env` bindings. Uses a plain
 * fake `env` (ASSETS `Fetcher` + RATE_LIMIT `KVNamespace` + ROOM_HUB `DurableObjectNamespace`) — no `workerd`.
 * @see ../../api
 */
import { describe, expect, it, vi } from "vitest";
import { createApi } from "../../api";
import { defaultConfig } from "../../config";
import type { HubEnvironment } from "../../types";

/** Builds a fake Cloudflare `env` (ASSETS Fetcher + RATE_LIMIT KV + ROOM_HUB DO namespace) with spies. */
function makeEnv(overrides?: { kvGet?: string | null }) {
  const assetsResponse = new Response("client", { status: 200 });
  // Sentinel only (identity-checked): node's Response rejects 101, which is why the DO's real 101 upgrade
  // is workerd-only and covered by the Wave-4 wrangler run, not here.
  const doResponse = new Response("do", { status: 200 });
  const stub = { fetch: vi.fn(async () => doResponse) };
  const assets = { fetch: vi.fn(async () => assetsResponse) };
  const kv = {
    get: vi.fn(async () => overrides?.kvGet ?? null),
    put: vi.fn(async () => undefined)
  };
  const hub = { getByName: vi.fn(() => stub) };
  const env = { ASSETS: assets, RATE_LIMIT: kv, ROOM_HUB: hub } as unknown as HubEnvironment;
  return { env, assets, kv, hub, stub, assetsResponse, doResponse };
}

/** Builds a WS-upgrade request for `path`. */
function wsRequest(path = "/K7M2QX"): Request {
  return new Request(`https://room.example.com${path}`, { headers: { Upgrade: "websocket" } });
}

describe("hub api — handle routing", () => {
  it("serves non-WS requests from the ASSETS binding", async () => {
    const { env, assets, assetsResponse } = makeEnv();
    const api = createApi({ config: defaultConfig });

    const res = await api.handle(
      new Request("https://room.example.com/index.html"),
      env,
      {} as ExecutionContext
    );

    expect(assets.fetch).toHaveBeenCalledTimes(1);
    expect(res).toBe(assetsResponse);
  });

  it("forwards a WS upgrade to the per-room DO and counts the join", async () => {
    const { env, hub, kv, stub, doResponse } = makeEnv();
    const api = createApi({ config: defaultConfig });

    const res = await api.handle(wsRequest("/K7M2QX"), env, {} as ExecutionContext);

    expect(hub.getByName).toHaveBeenCalledWith("K7M2QX");
    expect(stub.fetch).toHaveBeenCalledTimes(1);
    // The join counter is incremented with the configured TTL window.
    expect(kv.put).toHaveBeenCalledWith(expect.stringContaining("ratelimit:"), "1", {
      expirationTtl: defaultConfig.rateLimit.windowSec
    });
    expect(res).toBe(doResponse);
  });

  it("returns 400 for a WS upgrade with no room code", async () => {
    const { env, hub } = makeEnv();
    const api = createApi({ config: defaultConfig });

    const res = await api.handle(wsRequest("/"), env, {} as ExecutionContext);

    expect(res.status).toBe(400);
    expect(hub.getByName).not.toHaveBeenCalled();
  });

  it("returns 429 once the per-IP rate limit is reached", async () => {
    const { env, hub } = makeEnv({ kvGet: String(defaultConfig.rateLimit.joins) });
    const api = createApi({ config: defaultConfig });

    const res = await api.handle(wsRequest("/K7M2QX"), env, {} as ExecutionContext);

    expect(res.status).toBe(429);
    expect(hub.getByName).not.toHaveBeenCalled();
  });
});
