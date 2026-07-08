/**
 * @file Unit tests for the hub's `/api/ice` credential endpoint (`../../ice.ts`): the quiet
 * empty-200 no-secrets path (every local dev run), the per-IP KV rate limit, upstream mint success
 * in both of Cloudflare's body shapes (single object / array), and upstream failure → 502. Every
 * non-mint outcome is equivalent to the fail-open transport default — these assertions pin the
 * WORKER side of the contract.
 */
import { describe, expect, it } from "vitest";
import { ICE_PATH } from "../../../transport/ice-shared";
import { defaultConfig } from "../../config";
import { handleIce, type IceRateLimitKv } from "../../ice";

/** An in-memory KV stub implementing the structural rate-limit slice. */
function memoryKv(): IceRateLimitKv & { cells: Map<string, string> } {
  const cells = new Map<string, string>();
  return {
    cells,
    get: key => Promise.resolve(cells.get(key) ?? null),
    put: (key, value) => {
      cells.set(key, value);
      return Promise.resolve();
    }
  };
}

/**
 * A GET request to the ICE path, optionally carrying Cloudflare's client-IP header. The handler
 * treats the header as an opaque rate-bucket key, so the fixtures use readable non-IP tokens.
 */
function iceRequest(ip?: string): Request {
  return new Request(`https://hub.example${ICE_PATH}`, {
    headers: ip ? { "CF-Connecting-IP": ip } : {}
  });
}

/** A fetch stub for the upstream Cloudflare TURN API. */
function upstream(status: number, body: unknown): typeof fetch {
  return (() => Promise.resolve(Response.json(body, { status }))) as unknown as typeof fetch;
}

/** Await a handler response and read its status (keeps assertions single-expression lint-clean). */
async function statusOf(pending: Promise<Response>): Promise<number> {
  const response = await pending;
  return response.status;
}

/** Worker env carrying both TURN secrets under the default binding names. */
const SECRETS: Record<string, unknown> = {
  TURN_KEY_ID: "key-id",
  TURN_KEY_API_TOKEN: "api-token"
};

const CF_BODY = {
  iceServers: {
    urls: ["stun:stun.cloudflare.com:3478", "turn:turn.cloudflare.com:3478?transport=udp"],
    username: "u",
    credential: "c"
  }
};

describe("handleIce (hub /api/ice)", () => {
  it("answers a quiet empty 200 when the TURN secrets are absent (local dev, un-provisioned stage)", async () => {
    const neverCalled = (() => {
      throw new Error("upstream must not be called without secrets");
    }) as unknown as typeof fetch;

    for (const env of [{}, { TURN_KEY_ID: "only-half" }, { TURN_KEY_API_TOKEN: "only-half" }]) {
      // 200 with no `iceServers` field — expected state, so no red console line on every dev boot;
      // the fail-open transport default normalizes the missing field to its STUN fallback.
      const response = await handleIce(iceRequest(), env, defaultConfig, neverCalled);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({});
    }
  });

  it("rejects non-GET methods with 405", async () => {
    const post = new Request(`https://hub.example${ICE_PATH}`, { method: "POST" });
    expect(await statusOf(handleIce(post, SECRETS, defaultConfig))).toBe(405);
  });

  it("mints credentials from Cloudflare's single-object body and answers a no-store 200", async () => {
    const response = await handleIce(
      iceRequest("phone-a"),
      SECRETS,
      defaultConfig,
      upstream(201, CF_BODY)
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = (await response.json()) as { iceServers: unknown[] };
    expect(body.iceServers).toEqual([CF_BODY.iceServers]);
  });

  it("passes an array-form upstream body through unchanged", async () => {
    const arrayBody = {
      iceServers: [CF_BODY.iceServers, { urls: "stun:stun.cloudflare.com:3478" }]
    };
    const response = await handleIce(
      iceRequest(),
      SECRETS,
      defaultConfig,
      upstream(200, arrayBody)
    );

    const body = (await response.json()) as { iceServers: unknown[] };
    expect(body.iceServers).toHaveLength(2);
  });

  it("calls the credential endpoint for the configured key with the bearer token", async () => {
    let seenUrl: unknown;
    let seenInit: RequestInit | undefined;
    const spy = ((url: unknown, init?: RequestInit) => {
      seenUrl = url;
      seenInit = init;
      return Promise.resolve(Response.json(CF_BODY, { status: 200 }));
    }) as unknown as typeof fetch;

    await handleIce(iceRequest(), SECRETS, defaultConfig, spy);
    expect(seenUrl).toBe(
      "https://rtc.live.cloudflare.com/v1/turn/keys/key-id/credentials/generate"
    );
    expect(seenInit?.method).toBe("POST");
    expect(new Headers(seenInit?.headers).get("Authorization")).toBe("Bearer api-token");
    // The minted credential TTL rides in the POST body.
    expect(JSON.parse(String(seenInit?.body)) as { ttl: number }).toEqual({ ttl: 4 * 60 * 60 });
  });

  it("reads the secrets under CONFIGURED binding names (a consumer may rename them)", async () => {
    const config = {
      ...defaultConfig,
      ice: { ...defaultConfig.ice, keyIdBinding: "MY_KEY", apiTokenBinding: "MY_TOKEN" }
    };
    const env = { MY_KEY: "key-id", MY_TOKEN: "api-token" };

    expect(await statusOf(handleIce(iceRequest(), env, config, upstream(200, CF_BODY)))).toBe(200);
    // The default names are ignored under the renamed config → quiet empty 200.
    const response = await handleIce(iceRequest(), SECRETS, config, upstream(200, CF_BODY));
    expect(await response.json()).toEqual({});
  });

  it("answers 502 when the upstream mint fails (non-ok, garbage body, or a thrown fetch)", async () => {
    expect(await statusOf(handleIce(iceRequest(), SECRETS, defaultConfig, upstream(500, {})))).toBe(
      502
    );
    expect(
      await statusOf(
        handleIce(iceRequest(), SECRETS, defaultConfig, upstream(200, { iceServers: [] }))
      )
    ).toBe(502);

    const throwing = (() => Promise.reject(new Error("upstream down"))) as unknown as typeof fetch;
    expect(await statusOf(handleIce(iceRequest(), SECRETS, defaultConfig, throwing))).toBe(502);
  });

  it("rate-limits per IP through the configured KV: request max+1 in a window answers 429", async () => {
    const kv = memoryKv();
    const env: Record<string, unknown> = { ...SECRETS, RATE_LIMIT: kv };
    const ok = upstream(200, CF_BODY);

    for (let index = 0; index < defaultConfig.ice.rateLimit.max; index += 1) {
      expect(await statusOf(handleIce(iceRequest("phone-a"), env, defaultConfig, ok))).toBe(200);
    }
    expect(await statusOf(handleIce(iceRequest("phone-a"), env, defaultConfig, ok))).toBe(429);
    // A different IP has its own budget.
    expect(await statusOf(handleIce(iceRequest("phone-b"), env, defaultConfig, ok))).toBe(200);
    // Headerless callers (local dev) share the "unknown" bucket but are not blocked outright.
    expect(await statusOf(handleIce(iceRequest(), env, defaultConfig, ok))).toBe(200);
    expect(kv.cells.get("ice:unknown")).toBe("1");
  });
});
