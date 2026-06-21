/**
 * @file Unit tests for the room-hub plugin API (Cycle-2 W3): `handle` routing (non-WS → ASSETS, WS →
 * per-room DO, 429 over the rate limit, 400 without a code) and `deployManifest` shape. Uses plain fakes
 * for the resolved dependency APIs — no `workerd`.
 * @see ../../api
 */
import { describe, expect, it, vi } from "vitest";
import { createApi } from "../../api";
import { defaultConfig } from "../../config";
import type { RoomHubDeps } from "../../types";

/** Builds a `RoomHubDeps` bundle whose dependency APIs are spies, with overridable KV reads. */
function makeDeps(overrides?: { kvGet?: string | null }) {
  const assetsResponse = new Response("client", { status: 200 });
  // Sentinel only (identity-checked): node's Response rejects 101, which is exactly why the DO's real
  // 101 upgrade is workerd-only and covered by the Wave-4 wrangler run, not here.
  const doResponse = new Response("do", { status: 200 });
  const stub = { fetch: vi.fn(async () => doResponse) };

  const bindings = { require: vi.fn(() => ({ fetch: vi.fn(async () => assetsResponse) })) };
  const kv = {
    get: vi.fn(async () => overrides?.kvGet ?? null),
    put: vi.fn(async () => undefined),
    deployManifest: vi.fn(() => [{ kind: "kv", name: "room-rate-limit", binding: "RATE_LIMIT" }])
  };
  const durableObjects = {
    get: vi.fn(() => stub),
    deployManifest: vi.fn(() => [{ kind: "do", binding: "ROOM_HUB", className: "RoomHub" }])
  };

  const deps = {
    config: defaultConfig,
    durableObjects,
    kv,
    bindings
  } as unknown as RoomHubDeps;

  return { deps, bindings, kv, durableObjects, stub, assetsResponse, doResponse };
}

/** Builds a WS-upgrade request for `path`. */
function wsRequest(path = "/K7M2QX"): Request {
  return new Request(`https://room.example.com${path}`, { headers: { Upgrade: "websocket" } });
}

describe("roomHub api — handle routing", () => {
  it("serves non-WS requests from the ASSETS binding", async () => {
    const { deps, bindings, assetsResponse } = makeDeps();
    const api = createApi(deps);

    const res = await api.handle(
      new Request("https://room.example.com/index.html"),
      {},
      {} as ExecutionContext
    );

    expect(bindings.require).toHaveBeenCalledWith({}, "ASSETS");
    expect(res).toBe(assetsResponse);
  });

  it("forwards a WS upgrade to the per-room DO and counts the join", async () => {
    const { deps, durableObjects, kv, stub, doResponse } = makeDeps();
    const api = createApi(deps);

    const res = await api.handle(wsRequest("/K7M2QX"), {}, {} as ExecutionContext);

    expect(durableObjects.get).toHaveBeenCalledWith({}, "roomHub", "K7M2QX");
    expect(stub.fetch).toHaveBeenCalledTimes(1);
    // The join counter is incremented with the configured TTL window.
    expect(kv.put).toHaveBeenCalledWith({}, expect.stringContaining("ratelimit:"), "1", {
      expirationTtl: defaultConfig.rateLimit.windowSec
    });
    expect(res).toBe(doResponse);
  });

  it("returns 400 for a WS upgrade with no room code", async () => {
    const { deps, durableObjects } = makeDeps();
    const api = createApi(deps);

    const res = await api.handle(wsRequest("/"), {}, {} as ExecutionContext);

    expect(res.status).toBe(400);
    expect(durableObjects.get).not.toHaveBeenCalled();
  });

  it("returns 429 once the per-IP rate limit is reached", async () => {
    const limit = defaultConfig.rateLimit.joins;
    const { deps, durableObjects } = makeDeps({ kvGet: String(limit) });
    const api = createApi(deps);

    const res = await api.handle(wsRequest("/K7M2QX"), {}, {} as ExecutionContext);

    expect(res.status).toBe(429);
    expect(durableObjects.get).not.toHaveBeenCalled();
  });
});

describe("roomHub api — deployManifest", () => {
  it("returns the DO + rate-limit KV descriptors", () => {
    const { deps } = makeDeps();
    const api = createApi(deps);

    const manifest = api.deployManifest();

    expect(manifest).toContainEqual({ kind: "do", binding: "ROOM_HUB", className: "RoomHub" });
    expect(manifest).toContainEqual({ kind: "kv", name: "room-rate-limit", binding: "RATE_LIMIT" });
  });
});
