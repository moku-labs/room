/**
 * @file transport/ice-default.ts — the ZERO-CONFIG browser side of ICE provisioning: the default
 * lazy credential fetch (`/api/ice` on the hub origin) and the `?ice=relay` force-relay diagnostic.
 *
 * Wired by `ice.ts` when BOTH hold: the app left `TransportConfig.iceServers` at its default AND
 * the signaling adapter exposes an `iceEndpoint` (`serverSignaling` does). Strictly fail-open:
 * ANY failure (endpoint down, no secrets configured, timeout, garbage body) yields `undefined`,
 * and the transport keeps its public-STUN default — credentials are an upgrade, never a connect
 * dependency. The fetch is bounded by {@link ICE_FETCH_TIMEOUT_MS} and, as a provider, runs in
 * parallel with the signaling join (never on the boot critical path).
 */
import { ICE_FETCH_TIMEOUT_MS, normalizeIceServers } from "./ice-shared";
import type { IceServersProvider } from "./types";

/**
 * Fetch short-lived ICE servers (STUN + TURN relay) from a hub's credential endpoint.
 *
 * @param endpoint - The hub's credential endpoint (the adapter's `iceEndpoint`).
 * @param fetchImpl - Injectable fetch (tests); defaults to the global.
 * @returns The validated servers, or `undefined` to fail open onto the transport's STUN default.
 * @example
 * ```ts
 * const servers = await fetchIceServers("https://room.example.com/api/ice");
 * ```
 */
export async function fetchIceServers(
  endpoint: string,
  fetchImpl: typeof fetch = fetch
): Promise<readonly RTCIceServer[] | undefined> {
  try {
    const response = await fetchImpl(endpoint, {
      signal: AbortSignal.timeout(ICE_FETCH_TIMEOUT_MS)
    });
    if (!response.ok) return undefined;

    const body = (await response.json()) as { iceServers?: unknown } | null;
    return normalizeIceServers(body?.iceServers);
  } catch {
    // Fail open — the relay rung is an upgrade, never a boot dependency.
    return undefined;
  }
}

/**
 * Build the default lazy {@link IceServersProvider} over a hub credential endpoint — the provider
 * `ice.ts` swaps in when the app gave no explicit `iceServers` and the signaling adapter is
 * server-backed. Each invocation fetches FRESH short-lived credentials (a rejoin re-primes).
 *
 * @param endpoint - The hub's credential endpoint (the adapter's `iceEndpoint`).
 * @returns The lazy provider handed to `primeIceServers`.
 * @example
 * ```ts
 * const provider = defaultIceProvider(cfg.signaling.iceEndpoint);
 * ```
 */
export function defaultIceProvider(endpoint: string): IceServersProvider {
  return () => fetchIceServers(endpoint);
}

/**
 * Resolve the EFFECTIVE `iceTransportPolicy` for a new `RTCPeerConnection`: an explicit non-default
 * config wins untouched; the `"all"` default is upgraded to `"relay"` when the page URL carries the
 * `?ice=relay` diagnostic toggle. Force-relay is a deterministic end-to-end test of the TURN rung —
 * with `"relay"` only TURN candidate pairs form, so a successful pairing PROVES the relay works
 * (and fails by design when `/api/ice` minted nothing). A diagnostic, not a user-facing feature:
 * it only ever degrades the session that opts in, so it needs no build gating; any other `ice`
 * value is ignored, and off-browser (no `location`) the config value passes through.
 *
 * @param configured - The app's configured policy (`TransportConfig.iceTransportPolicy`).
 * @param search - Injectable query string (tests); defaults to the page's `location.search`.
 * @returns The policy to construct the next `RTCPeerConnection` with.
 * @example
 * ```ts
 * new RTCPeerConnection({ iceServers, iceTransportPolicy: effectiveIcePolicy(cfg.iceTransportPolicy) });
 * ```
 */
export function effectiveIcePolicy(
  configured: RTCIceTransportPolicy,
  search?: string
): RTCIceTransportPolicy {
  if (configured !== "all") return configured;

  const query = search ?? (typeof location === "undefined" ? "" : location.search);
  return new URLSearchParams(query).get("ice") === "relay" ? "relay" : "all";
}
