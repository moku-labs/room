/**
 * @file Lazy-loaded implementation for the `serverSignaling` adapter (D21/D25).
 *
 * Imported dynamically inside `server.ts`'s `join()` so web bundles that never call
 * `serverSignaling` pay zero bundle cost. Speaks the contracts §1.3
 * `ClientEnvelope`/`ServerEnvelope` protocol over a single persistent WebSocket.
 * @see ./server.ts
 * @see ../protocol
 */
import type {
  ClientEnvelope,
  PeerId,
  ServerEnvelope,
  SignalingJoinOpts,
  SignalingSession,
  SignalMsg
} from "../protocol";

/**
 * Resolves the `leave()` promise once a WebSocket reaches CLOSED state. Registers a one-shot
 * `close` listener; if the socket is already closed it resolves synchronously.
 *
 * Extracted to the module scope to avoid sonarjs/no-nested-functions (the listener body was
 * previously inlined inside a Promise constructor inside `session.leave()`).
 *
 * @param ws - The WebSocket to wait on.
 * @returns A promise that resolves once the socket closes.
 * @example
 * ```ts
 * ws.close(1000, "leave");
 * await waitForClose(ws);
 * ```
 */
function waitForClose(ws: WebSocket): Promise<void> {
  return new Promise<void>(resolve => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    ws.addEventListener("close", () => {
      resolve();
    });
  });
}

/**
 * Builds a live `SignalingSession` over a single persistent WebSocket to the hub worker.
 *
 * Protocol:
 *  - On open: sends `{kind:"join", selfId, role}` — or `{kind:"reclaim", selfId, reclaimToken}` when
 *    `opts.reclaimToken` is set (host-reload re-entry, §1.3/§5.1, D25).
 *  - `join-ack`: resolves the promise; pre-existing `peers` are queued for `onPeer`; the DO-issued
 *    `reclaimToken` is exposed on `session.reclaimToken` for `session` to persist.
 *  - `reclaim-ack`: resolves a reclaim `join` (the host re-attached to the warm DO); `peers` (the live
 *    controllers) are queued for `onPeer` so the host re-offers; `session.reclaimToken` is the token
 *    that was presented (the DO keeps it stable across reclaim).
 *  - `peer-arrived` → `onPeer` callback.
 *  - `peer-left` → `onPeerLeave` callback.
 *  - `relay` → `onSignal` callback.
 *  - `evict` → `onEvict` callback.
 *  - `session.send(to, msg)` → `{kind:"relay", to, msg}` sent over the WS.
 *  - `session.leave()` → `ws.close(1000)`.
 *
 * The returned session has `persistent: true` so `handlers.ts` skips the post-ICE
 * `leave()` / null and keeps the WS open as the discovery-push conduit (D25).
 *
 * @param url - Base `wss://…` URL of the hub worker.
 * @param code - The 6-char room code identifying the WS endpoint.
 * @param opts - Self id and passive/active role.
 * @returns A `persistent: true` `SignalingSession`.
 * @example
 * ```ts
 * const session = await buildServerSession("wss://r.example.com", "K7M2QX", { selfId: "host_root" });
 * ```
 */
export function buildServerSession(
  url: string,
  code: string,
  opts: SignalingJoinOpts
): Promise<SignalingSession> {
  return new Promise<SignalingSession>((resolve, reject) => {
    const wsUrl = `${url}/${code}`;
    const ws = new WebSocket(wsUrl);

    // Callbacks set by the session consumer after resolution.
    let onPeerCallback: ((peerId: PeerId) => void) | null = null;
    let onPeerLeaveCallback: ((peerId: PeerId) => void) | null = null;
    let onSignalCallback: ((peerId: PeerId, msg: SignalMsg) => void) | null = null;
    let onEvictCallback: (() => void) | null = null;

    // Peers from `join-ack` that arrived before `onPeer` was registered.
    const pendingPeers: PeerId[] = [];

    /**
     * Sends a typed `ClientEnvelope` frame to the DO over the WS (no-op when not OPEN).
     *
     * @param envelope - The client frame to send.
     * @example
     * ```ts
     * sendFrame({ kind: "join", selfId: "host_root", role: "host" });
     * ```
     */
    function sendFrame(envelope: ClientEnvelope): void {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(envelope));
      }
    }

    /**
     * Delivers a peer id to the registered `onPeer` callback, or queues it for later delivery
     * when `onPeer` is registered after some peers have already arrived.
     *
     * @param peerId - The peer id to deliver.
     * @example
     * ```ts
     * notifyPeer("p_ab12");
     * ```
     */
    function notifyPeer(peerId: PeerId): void {
      if (onPeerCallback) {
        onPeerCallback(peerId);
      } else {
        pendingPeers.push(peerId);
      }
    }

    /**
     * Builds the live `SignalingSession` once the DO acknowledges (`join-ack` or `reclaim-ack`). Shared
     * by both acks so a reclaimed host and a fresh joiner get an identical session surface; the only
     * difference is the `reclaimToken` carried (the DO mints it on `join-ack` and echoes the presented
     * one on `reclaim-ack`).
     *
     * @param token - The DO-issued reclaim token to expose on `session.reclaimToken`.
     * @returns The persistent signaling session.
     * @example
     * ```ts
     * resolve(makeSession("f81d4fae-7dec-11d0-a765-00a0c91e6bf6"));
     * ```
     */
    /* eslint-disable jsdoc/require-jsdoc -- structural SignalingSession methods; semantics are documented on the contract in contracts.ts §1 */
    function makeSession(token: string | undefined): SignalingSession {
      const base: SignalingSession = {
        persistent: true,
        onPeer(cb) {
          onPeerCallback = cb;
          // Drain any peers that arrived before onPeer was registered.
          const queued = pendingPeers.splice(0);
          for (const peerId of queued) cb(peerId);
        },
        onPeerLeave(cb) {
          onPeerLeaveCallback = cb;
        },
        onSignal(cb) {
          onSignalCallback = cb;
        },
        send(to, msg) {
          sendFrame({ kind: "relay", to, msg });
        },
        async leave() {
          ws.close(1000, "leave");
          await waitForClose(ws);
        },
        onEvict(cb) {
          onEvictCallback = cb;
        }
      };
      // exactOptionalPropertyTypes: only attach reclaimToken when the DO actually issued one.
      return token === undefined ? base : { ...base, reclaimToken: token };
    }

    // WS lifecycle: open → send join (or reclaim on host-reload re-entry), error → reject,
    // message → dispatch ServerEnvelope.

    // On open: send join/reclaim.
    ws.addEventListener("open", () => {
      // A persisted reclaim token means this is a host reload re-attaching to the warm DO (§5.1, D25):
      // send {kind:"reclaim",…} so controllers keep their room; otherwise a normal {kind:"join",…}.
      if (opts.reclaimToken !== undefined) {
        sendFrame({ kind: "reclaim", selfId: opts.selfId, reclaimToken: opts.reclaimToken });
        return;
      }
      const role = opts.passive === true ? "controller" : "host";
      sendFrame({ kind: "join", selfId: opts.selfId, role });
    });

    // On error: reject.
    ws.addEventListener("error", () => {
      reject(new Error(`serverSignaling: WebSocket error connecting to ${wsUrl}`));
    });

    // On message: dispatch the ServerEnvelope by kind.
    ws.addEventListener("message", (event: MessageEvent<string>) => {
      let envelope: ServerEnvelope;
      try {
        envelope = JSON.parse(event.data) as ServerEnvelope;
      } catch {
        return;
      }

      switch (envelope.kind) {
        case "join-ack": {
          // Pre-existing peers from the ack are queued and delivered via notifyPeer.
          for (const peerId of envelope.peers) {
            notifyPeer(peerId);
          }
          // Expose the DO-issued reclaim token so session can persist it for host-reload re-entry.
          resolve(makeSession(envelope.reclaimToken));
          break;
        }
        case "reclaim-ack": {
          // The host re-attached to the warm DO: its live controllers come back as `peers` so the host
          // re-offers to each (the active side of the star); the presented token stays the session token.
          for (const peerId of envelope.peers) {
            notifyPeer(peerId);
          }
          resolve(makeSession(opts.reclaimToken));
          break;
        }
        case "peer-arrived": {
          notifyPeer(envelope.peerId);
          break;
        }
        case "peer-left": {
          onPeerLeaveCallback?.(envelope.peerId);
          break;
        }
        case "relay": {
          onSignalCallback?.(envelope.from, envelope.msg);
          break;
        }
        case "evict": {
          onEvictCallback?.();
          break;
        }
        // full, error — no action needed at the signaling-seam level.
        case "full":
        case "error": {
          break;
        }
        default: {
          break;
        }
      }
    });
  });
}
