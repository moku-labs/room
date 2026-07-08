/**
 * @file transport/adapters/server.ts — opt-in server-backed Signaling adapter (D21/D25).
 *
 * Opens ONE persistent WebSocket to the hub worker per `join(code)`. Speaks the
 * contracts §1.3 `ClientEnvelope` / `ServerEnvelope` protocol. Returns a `SignalingSession`
 * with `persistent: true` so `handlers.ts` keeps the session open post-ICE as the
 * discovery-push / host-reload reclaim conduit.
 *
 * Heavy WS/envelope logic is lazy-loaded inside `join()` (dynamic import) so web bundles
 * that never call `serverSignaling` pay zero bundle cost (mirrors `public-rendezvous.ts`).
 *
 * Envelope mapping:
 *  - `peer-arrived → session.onPeer`
 *  - `peer-left → session.onPeerLeave`
 *  - `relay → session.onSignal`
 *  - `session.send(peer, msg) → {kind:"relay", to, msg}`
 *  - `{kind:"evict"} → session.onEvict cb`
 *  - `session.leave() → ws.close(1000)`
 * @see ../protocol
 */
import { ICE_PATH } from "../ice-shared";
import type { Signaling, SignalingJoinOpts, SignalingSession } from "../protocol";

/**
 * Builds an opt-in {@link Signaling} adapter backed by a Moku Worker hub. One persistent
 * WebSocket per `join(code)`; the returned session sets `persistent: true` so transport keeps it
 * open post-ICE as the discovery-push and host-reload reclaim conduit (D25).
 *
 * @param url - The `wss://…` base URL of the deployed hub worker.
 * @returns A {@link Signaling} interchangeable with `publicRendezvous`/`inMemory`.
 * @example
 * ```ts
 * createApp({ pluginConfigs: { transport: { signaling: serverSignaling("wss://room.example.com") } } });
 * ```
 */
export function serverSignaling(url: string): Signaling {
  /**
   * Lazy implementation — loaded inside `join()` to keep the factory thin.
   *
   * @param code - The room code whose WS endpoint to connect to.
   * @param opts - Self id and passive/active role.
   * @returns A persistent `SignalingSession` over the worker WebSocket.
   * @example
   * ```ts
   * const session = await serverSignaling("wss://r.example.com").join("K7M2QX", { selfId: "host_root" });
   * ```
   */
  const join = async (code: string, opts: SignalingJoinOpts): Promise<SignalingSession> => {
    // Dynamic import so web bundles that never call serverSignaling() pay nothing.
    const { buildServerSession } = await import("./server-impl");
    return buildServerSession(url, code, opts);
  };

  // The hub serves the TURN-credential endpoint on the same origin as its signaling WS — expose it
  // so transport can default its lazy ICE provider (zero-config internet play; `ice.ts`).
  return { join, ...maybeIceEndpoint(url) };
}

/**
 * Derive the hub's ICE-credential endpoint from its signaling URL via the `URL` API:
 * `ws(s)://host` → `http(s)://host/api/ice`. An unparsable URL yields no endpoint (fail-open —
 * `join()` will surface the real error; the ICE default simply stays on STUN).
 *
 * @param url - The `ws(s)://…` hub base URL.
 * @returns `{ iceEndpoint }`, or `{}` when the URL does not parse.
 * @example
 * ```ts
 * maybeIceEndpoint("wss://room.example.com"); // { iceEndpoint: "https://room.example.com/api/ice" }
 * ```
 */
function maybeIceEndpoint(url: string): { iceEndpoint?: string } {
  try {
    const endpoint = new URL(url);
    endpoint.protocol = endpoint.protocol === "wss:" ? "https:" : "http:";
    endpoint.pathname = ICE_PATH;
    endpoint.search = "";
    endpoint.hash = "";
    return { iceEndpoint: endpoint.toString() };
  } catch {
    return {};
  }
}
