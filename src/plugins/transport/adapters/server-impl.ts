/**
 * @file Lazy-loaded implementation for the `serverSignaling` adapter (D21/D25).
 *
 * Imported dynamically inside `server.ts`'s `join()` so web bundles that never call
 * `serverSignaling` pay zero bundle cost. Speaks the contracts §1.3
 * `ClientEnvelope`/`ServerEnvelope` protocol over a single persistent WebSocket.
 * @see ./server.ts
 * @see ../../../contracts
 */
import type {
  ClientEnvelope,
  PeerId,
  ServerEnvelope,
  SignalingJoinOpts,
  SignalingSession,
  SignalMsg
} from "../../../contracts";

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
 * Builds a live `SignalingSession` over a single persistent WebSocket to the room-hub worker.
 *
 * Protocol:
 *  - On open: sends `{kind:"join", selfId, role}`.
 *  - `join-ack`: resolves the promise; pre-existing `peers` are queued for `onPeer`.
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
 * @param url - Base `wss://…` URL of the room-hub worker.
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

    // WS lifecycle: open → send join, error → reject, message → dispatch ServerEnvelope.
    /* eslint-disable jsdoc/require-jsdoc -- anonymous WS event callbacks; documented by the parent function's JSDoc protocol section */
    ws.addEventListener("open", () => {
      const role = opts.passive === true ? "controller" : "host";
      sendFrame({ kind: "join", selfId: opts.selfId, role });
    });

    ws.addEventListener("error", () => {
      reject(new Error(`serverSignaling: WebSocket error connecting to ${wsUrl}`));
    });

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
          const session: SignalingSession = {
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
          resolve(session);
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
        // reclaim-ack, full, error — no action needed at the signaling-seam level.
        case "reclaim-ack":
        case "full":
        case "error": {
          break;
        }
        default: {
          break;
        }
      }
    });
    /* eslint-enable jsdoc/require-jsdoc */
  });
}
