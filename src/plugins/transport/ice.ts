/**
 * @file ICE-server resolution — the lazy `IceServersProvider` seam of `TransportConfig.iceServers`.
 * @see README.md
 *
 * `connect()` PRIMES the provider (fire-and-forget) so a consumer's credential fetch — e.g. minting
 * short-lived TURN credentials from its own worker — runs in parallel with the signaling join instead
 * of serially before `createApp`. Peer creation then reads the resolved set synchronously when it is
 * already available (the common case: peers arrive on a human timescale, long after a ~100 ms fetch)
 * and otherwise waits, bounded by `openTimeoutMs`. Every failure mode — the provider resolving
 * `undefined`, throwing, or outlasting the bounded wait — fails OPEN onto `DEFAULT_ICE_SERVERS`
 * (the public-STUN default), never closed: credentials are an upgrade, not a connect dependency.
 * A resolution that arrives after the bounded wait is still stored for subsequently-created peers.
 */
import { DEFAULT_ICE_SERVERS } from "./config";
import { defaultIceProvider } from "./ice-default";
import type { IceServersProvider, TransportConfig, TransportState } from "./types";

/**
 * Resolve the EFFECTIVE `iceServers` source: explicit config (array or provider) wins untouched;
 * the `"auto"` default sentinel resolves per the signaling adapter — server-backed (it exposes
 * `iceEndpoint`; `serverSignaling` does) → the built-in lazy `/api/ice` credential provider, any
 * other adapter → {@link DEFAULT_ICE_SERVERS} (the public-STUN fallback). This is the zero-config
 * internet-play default: compose a hub, and the relay rung provisions itself — strictly fail-open
 * back onto the STUN fallback, so a hub without TURN secrets (every local dev run) behaves exactly
 * like a plain STUN config. Any explicit value (even `[]` for LAN-only) replaces the sentinel.
 *
 * @param cfg - The transport config (`iceServers` + the signaling adapter).
 * @returns The source `prime`/`peek`/`ready` operate on.
 * @example
 * ```ts
 * const source = effectiveIceSource(cfg); // serverSignaling + "auto" → the /api/ice provider
 * ```
 */
export function effectiveIceSource(
  cfg: Readonly<TransportConfig>
): readonly RTCIceServer[] | IceServersProvider {
  const source = cfg.iceServers;
  if (source !== "auto") return source;

  const endpoint = cfg.signaling.iceEndpoint;
  return endpoint === undefined ? DEFAULT_ICE_SERVERS : defaultIceProvider(endpoint);
}

/**
 * Starts (or restarts) ICE-server resolution for a new connection epoch. Array config is mirrored
 * into `state.iceServers` as-is; a provider is invoked NOW — `connect()` calls this before awaiting
 * the signaling join, so the two run concurrently — with its resolution stored on settle. Re-priming
 * (a rejoin) re-invokes the provider for fresh short-lived credentials; the `state.icePending`
 * identity check keeps a superseded epoch's late resolution from clobbering the current one.
 *
 * @param state - The per-app transport state the resolution is stored on.
 * @param cfg - The transport config whose `iceServers` is an array or provider.
 * @example
 * ```ts
 * primeIceServers(state, cfg); // fire-and-forget, then: await cfg.signaling.join(...)
 * ```
 */
export function primeIceServers(state: TransportState, cfg: Readonly<TransportConfig>): void {
  const source = effectiveIceSource(cfg);

  // Array config: resolved by definition — mirror and done.
  if (typeof source !== "function") {
    state.iceServers = source;
    state.icePending = null;
    return;
  }

  // Provider config: a fresh epoch invalidates any prior resolution (short-lived credentials).
  state.iceServers = null;
  const pending: Promise<readonly RTCIceServer[]> = source()
    .then(servers => servers ?? DEFAULT_ICE_SERVERS)
    .catch(() => DEFAULT_ICE_SERVERS)
    .then(servers => {
      // Stale-epoch guard: only the still-registered pending resolution may write.
      if (state.icePending === pending) {
        state.iceServers = servers;
        state.icePending = null;
      }
      return servers;
    });
  state.icePending = pending;
}

/**
 * Synchronous read of the ICE servers when they are already known: array config directly, or a
 * provider's stored resolution. `null` means a provider is (or should be) in flight — callers fall
 * back to {@link iceServersReady} and defer peer creation.
 *
 * @param state - The per-app transport state holding a provider's resolution.
 * @param cfg - The transport config whose `iceServers` is an array or provider.
 * @returns The resolved ICE servers, or `null` when a provider has not resolved yet.
 * @example
 * ```ts
 * const servers = peekIceServers(state, cfg);
 * if (servers) createPeer(state, cfg, peerId, servers);
 * ```
 */
export function peekIceServers(
  state: TransportState,
  cfg: Readonly<TransportConfig>
): readonly RTCIceServer[] | null {
  const source = effectiveIceSource(cfg);
  return typeof source === "function" ? state.iceServers : source;
}

/**
 * Awaits the ICE servers for peer creation, bounded by `cfg.openTimeoutMs`. Resolves immediately when
 * already known; otherwise waits on the in-flight provider (priming it defensively if `connect()`
 * never did) and, past the bound, fails open onto `DEFAULT_ICE_SERVERS` so a hung provider can only
 * DELAY a handshake by the open-timeout beat — never wedge it silently. Never rejects.
 *
 * @param state - The per-app transport state holding the provider resolution.
 * @param cfg - The transport config (`iceServers` source + `openTimeoutMs` bound).
 * @returns The ICE servers to construct the next `RTCPeerConnection` with.
 * @example
 * ```ts
 * const servers = await iceServersReady(state, cfg);
 * const pc = new RTCPeerConnection({ iceServers: [...servers] });
 * ```
 */
export function iceServersReady(
  state: TransportState,
  cfg: Readonly<TransportConfig>
): Promise<readonly RTCIceServer[]> {
  const known = peekIceServers(state, cfg);
  if (known) return Promise.resolve(known);

  // Defensive prime (a direct handler call without connect()); array config resolves right here.
  if (state.icePending === null) primeIceServers(state, cfg);
  const primed = peekIceServers(state, cfg);
  if (primed) return Promise.resolve(primed);
  const pending = state.icePending;
  if (pending === null) return Promise.resolve(DEFAULT_ICE_SERVERS);

  // Bounded wait: the provider races the open-timeout beat; losing fails open (late wins are stored).
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(DEFAULT_ICE_SERVERS), cfg.openTimeoutMs);
    pending
      .then(servers => {
        clearTimeout(timer);
        resolve(servers);
      })
      .catch(() => {
        // unreachable — the prime's catch already folded provider failure into the default set
      });
  });
}
