/**
 * @file Unit tests for the zero-config ICE defaults: the DOM-free normalizer (`ice-shared.ts`),
 * the fail-open default credential fetch + `?ice=relay` policy toggle (`ice-default.ts`), the
 * `effectiveIceSource` upgrade rule (`ice.ts`), and `serverSignaling`'s derived `iceEndpoint`.
 * The contract under test: compose a hub → the relay rung provisions itself; ANY explicit config
 * or ANY failure leaves today's public-STUN behaviour untouched.
 */
import { describe, expect, it, vi } from "vitest";
import { serverSignaling } from "../../adapters/server";
import { DEFAULT_ICE_SERVERS } from "../../config";
import { effectiveIceSource, iceServersReady, primeIceServers } from "../../ice";
import { defaultIceProvider, effectiveIcePolicy, fetchIceServers } from "../../ice-default";
import { ICE_FETCH_TIMEOUT_MS, ICE_PATH, normalizeIceServers } from "../../ice-shared";
import { createTransportState } from "../../state";
import type { TransportConfig } from "../../types";

/** A minimal transport config over the given iceServers + signaling adapter. */
function makeConfig(
  iceServers: TransportConfig["iceServers"],
  signaling?: TransportConfig["signaling"]
): TransportConfig {
  return {
    signaling: signaling ?? { join: vi.fn() },
    iceServers,
    heartbeatIntervalMs: 2000,
    heartbeatTimeoutMs: 6000,
    openTimeoutMs: 3000,
    iceTransportPolicy: "all",
    maxMessageBytes: 14_336
  };
}

/** A fetch stub answering the hub credential endpoint. */
function endpointFetch(status: number, body: unknown): typeof fetch {
  return (() => Promise.resolve(Response.json(body, { status }))) as unknown as typeof fetch;
}

const MINTED = {
  iceServers: [{ urls: "turn:turn.cloudflare.com:3478", username: "u", credential: "c" }]
};

/** An explicit consumer-supplied provider — must pass through `effectiveIceSource` untouched. */
const explicitProvider = async (): Promise<readonly RTCIceServer[] | undefined> =>
  MINTED.iceServers;

describe("normalizeIceServers (DOM-free shared normalizer)", () => {
  it("normalizes Cloudflare's single-object body form into a one-entry array", () => {
    expect(normalizeIceServers(MINTED.iceServers[0])).toEqual(MINTED.iceServers);
  });

  it("keeps valid array entries and drops garbage ones", () => {
    const mixed = [
      MINTED.iceServers[0],
      { urls: "" }, // empty string url is still a string — kept as-is by the urls contract
      { urls: [] }, // empty array → dropped
      { urls: [42] }, // non-string entries → dropped
      "nonsense",
      null
    ];
    const result = normalizeIceServers(mixed);
    expect(result).toBeDefined();
    expect(result).toContainEqual(MINTED.iceServers[0]);
    expect(result?.every(server => typeof server === "object")).toBe(true);
  });

  it("yields undefined when nothing usable survives (fail-open cue)", () => {
    expect(normalizeIceServers(undefined)).toBeUndefined();
    expect(normalizeIceServers("garbage")).toBeUndefined();
    expect(normalizeIceServers([{ username: "u" }])).toBeUndefined();
  });

  it("carries TURN credentials through and omits them for STUN entries", () => {
    const stun = normalizeIceServers({ urls: "stun:stun.example:3478" });
    expect(stun).toEqual([{ urls: "stun:stun.example:3478" }]);
    expect(Object.keys(stun?.[0] ?? {})).toEqual(["urls"]);
  });
});

describe("fetchIceServers (the fail-open default credential fetch)", () => {
  it("resolves the normalized servers from a healthy endpoint", async () => {
    const servers = await fetchIceServers(
      "https://hub.example/api/ice",
      endpointFetch(200, MINTED)
    );
    expect(servers).toEqual(MINTED.iceServers);
  });

  it("fails open (undefined) on non-ok, empty-200 (no secrets), garbage, and thrown fetch", async () => {
    expect(await fetchIceServers("https://x/api/ice", endpointFetch(503, {}))).toBeUndefined();
    expect(await fetchIceServers("https://x/api/ice", endpointFetch(200, {}))).toBeUndefined();
    expect(
      await fetchIceServers("https://x/api/ice", endpointFetch(200, { iceServers: "?" }))
    ).toBeUndefined();

    const throwing = (() => Promise.reject(new Error("down"))) as unknown as typeof fetch;
    expect(await fetchIceServers("https://x/api/ice", throwing)).toBeUndefined();
  });

  it("bounds the fetch with an abort signal (never blocks a boot past the budget)", async () => {
    let seenInit: RequestInit | undefined;
    const spy = ((_url: unknown, init?: RequestInit) => {
      seenInit = init;
      return Promise.resolve(Response.json(MINTED, { status: 200 }));
    }) as unknown as typeof fetch;

    await fetchIceServers("https://hub.example/api/ice", spy);
    expect(seenInit?.signal).toBeInstanceOf(AbortSignal);
    expect(ICE_FETCH_TIMEOUT_MS).toBe(2000);
  });
});

describe("effectiveIcePolicy (?ice=relay force-relay diagnostic)", () => {
  it("passes an explicit non-default policy through untouched", () => {
    expect(effectiveIcePolicy("relay", "")).toBe("relay");
    expect(effectiveIcePolicy("relay", "?ice=all")).toBe("relay");
  });

  it("upgrades the default to relay ONLY on ?ice=relay", () => {
    expect(effectiveIcePolicy("all", "?ice=relay")).toBe("relay");
    expect(effectiveIcePolicy("all", "?foo=1&ice=relay")).toBe("relay");
    expect(effectiveIcePolicy("all", "?ice=bogus")).toBe("all");
    expect(effectiveIcePolicy("all", "")).toBe("all");
  });

  it("off-browser (no location, no injected search) the config value passes through", () => {
    expect(effectiveIcePolicy("all")).toBe("all");
  });
});

describe("serverSignaling — derived iceEndpoint", () => {
  it("derives http(s)://…/api/ice from the ws(s) hub URL (trailing slashes stripped)", () => {
    expect(serverSignaling("wss://room.example.com").iceEndpoint).toBe(
      `https://room.example.com${ICE_PATH}`
    );
    expect(serverSignaling("ws://localhost:8787/").iceEndpoint).toBe(
      `http://localhost:8787${ICE_PATH}`
    );
  });
});

describe("effectiveIceSource (the zero-config 'auto' sentinel)", () => {
  it("resolves 'auto' to the /api/ice provider for a server-backed adapter, else the STUN fallback", () => {
    const server = makeConfig("auto", serverSignaling("wss://room.example.com"));
    expect(typeof effectiveIceSource(server)).toBe("function");

    const plain = makeConfig("auto"); // no iceEndpoint (publicRendezvous/inMemory shape)
    expect(effectiveIceSource(plain)).toBe(DEFAULT_ICE_SERVERS);
  });

  it("any EXPLICIT config replaces the sentinel — arrays (even []) and providers pass untouched", () => {
    const signaling = serverSignaling("wss://room.example.com");
    const lanOnly = makeConfig([], signaling);
    expect(effectiveIceSource(lanOnly)).toEqual([]);

    const custom: TransportConfig["iceServers"] = [{ urls: "stun:stun.example:3478" }];
    expect(effectiveIceSource(makeConfig(custom, signaling))).toBe(custom);

    expect(effectiveIceSource(makeConfig(explicitProvider, signaling))).toBe(explicitProvider);
  });

  it("primes through the default provider: a healthy endpoint yields minted servers, a dead one the STUN default", async () => {
    const globalFetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json(MINTED, { status: 200 }));
    try {
      const cfg = makeConfig("auto", serverSignaling("wss://room.example.com"));
      const state = createTransportState();
      primeIceServers(state, cfg);
      expect(await iceServersReady(state, cfg)).toEqual(MINTED.iceServers);
      expect(globalFetch).toHaveBeenCalledWith(
        `https://room.example.com${ICE_PATH}`,
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );

      globalFetch.mockRejectedValue(new Error("endpoint down"));
      const state2 = createTransportState();
      primeIceServers(state2, cfg);
      expect(await iceServersReady(state2, cfg)).toEqual(DEFAULT_ICE_SERVERS);
    } finally {
      globalFetch.mockRestore();
    }
  });

  it("defaultIceProvider mints FRESH credentials per invocation (a rejoin re-primes)", async () => {
    const calls: number[] = [];
    const spy = (() => {
      calls.push(1);
      return Promise.resolve(Response.json(MINTED, { status: 200 }));
    }) as unknown as typeof fetch;
    const globalFetch = vi.spyOn(globalThis, "fetch").mockImplementation(spy);
    try {
      const provider = defaultIceProvider("https://hub.example/api/ice");
      await provider();
      await provider();
      expect(calls).toHaveLength(2);
    } finally {
      globalFetch.mockRestore();
    }
  });
});
