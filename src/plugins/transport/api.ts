/**
 * @file `transportPlugin` API factory — `connect`/`wire`/`disconnect`/`peers`/`close`.
 * @see README.md
 *
 * The public surface is small: `connect` is the on-demand entry point (called by `sessionPlugin` on room
 * create/join — NOT at app boot), `wire()` hands the typed channel to the engines, and `disconnect` /
 * `close` tear down. Operates on the per-app `state` + frozen `config` the wiring harness passes (D14).
 * Gameplay rides the `Wire`, never Moku `emit`. The factory takes the destructured per-app pieces (not a
 * `ctx`): `@moku-labs/web` infers `ctx` inline in `index.ts`, so the declared `room:network-warning`
 * event flows into the bound `emitWarning` closure.
 */
import type { RoomEvents, SignalingJoinOpts, Wire } from "../../contracts";
import { createWire, disconnectPeer, startHeartbeat, tearDownState } from "./channel";
import { handlePeerArrival, handlePeerLeave, handleSignal } from "./handlers";
import type { ConnectOpts, TransportApi, TransportConfig, TransportState } from "./types";

/**
 * Builds the `transportPlugin` API for one app instance from its per-app `state`, frozen `config`, and a
 * narrowed `emitWarning` closure (the wiring harness binds `ctx.emit`). `connect` joins the signaling
 * room (host active / controller passive) and wires the handshake glue; `wire()` returns the stable
 * `Wire`; `disconnect` tears down one peer; `peers()` snapshots the live ids; `close()` runs the full
 * teardown against `state` (the same sequence `onStop` runs via the registry).
 *
 * @param state - The per-app transport state (peer map, signaling session, timers).
 * @param cfg - The frozen per-app transport config (ICE servers, timings, chunk threshold).
 * @param emitWarning - Narrowed `ctx.emit` closure for the single owned `room:network-warning` event.
 * @returns The transport API bound to this app instance.
 * @example
 * ```ts
 * const api = createTransportApi(ctx.state, ctx.config, reason =>
 *   ctx.emit("room:network-warning", { reason })
 * );
 * await api.connect({ role: "host", selfId: "host_root", code: "K7M2QX" });
 * ```
 */
export function createTransportApi(
  state: TransportState,
  cfg: Readonly<TransportConfig>,
  emitWarning: (reason: RoomEvents["room:network-warning"]["reason"]) => void
): TransportApi {
  // Stable per-app Wire — same identity every `wire()` call (contracts section 2).
  const wire: Wire = createWire(state, cfg);

  return {
    /** @inheritdoc */
    async connect(opts: ConnectOpts): Promise<void> {
      state.role = opts.role;
      state.selfId = opts.selfId;
      // Idempotent: a prior live session is released before rejoining so it cannot leak (contracts §1.2).
      if (state.session) {
        await state.session.leave().catch(() => {
          // a stale session's leave() is best-effort; failure must not block the rejoin
        });
        state.session = null;
      }
      // Star role → passive flag; thread the host-reload reclaim token only when present (exact-optional:
      // omit the key entirely rather than passing `undefined`). serverSignaling sends {kind:"reclaim"}
      // when it is set; other adapters ignore it (contracts §1.3, D25).
      const joinOpts: SignalingJoinOpts =
        opts.reclaimToken === undefined
          ? { selfId: opts.selfId, passive: opts.role === "controller" }
          : {
              selfId: opts.selfId,
              passive: opts.role === "controller",
              reclaimToken: opts.reclaimToken
            };
      let session: TransportState["session"];
      try {
        session = await cfg.signaling.join(opts.code, joinOpts);
      } catch (error) {
        emitWarning("rendezvous-unreachable");
        throw error;
      }
      state.session = session;
      session.onPeer(peerId =>
        handlePeerArrival(state, cfg, peerId, reason => emitWarning(reason))
      );
      session.onSignal((peerId, msg) => handleSignal(state, cfg, peerId, msg));
      session.onPeerLeave(peerId => handlePeerLeave(state, peerId));
      // onEvict wiring (contracts §1.1, D25): surfaces serverSignaling eviction as a network warning.
      // No-op for publicRendezvous/inMemory (onEvict is optional; contracts §1.1).
      session.onEvict?.(() => emitWarning("room-evicted"));
      startHeartbeat(state, cfg, reason => emitWarning(reason));
    },

    /** @inheritdoc */
    wire(): Wire {
      return wire;
    },

    /** @inheritdoc */
    disconnect(peerId): void {
      disconnectPeer(state, peerId);
    },

    /** @inheritdoc */
    reclaimToken(): string | null {
      return state.session?.reclaimToken ?? null;
    },

    /** @inheritdoc */
    peers(): readonly string[] {
      const connected: string[] = [];
      for (const peer of state.peers.values()) {
        if (peer.state === "connected") connected.push(peer.peerId);
      }
      return connected;
    },

    /** @inheritdoc */
    async close(): Promise<void> {
      await tearDownState(state);
      state.role = "idle";
      state.selfId = "";
    },

    /** @inheritdoc */
    onPeerConnected(cb) {
      state.peerConnectedCb = cb;
      return () => {
        if (state.peerConnectedCb === cb) state.peerConnectedCb = null;
      };
    },

    /** @inheritdoc */
    onPeerLost(cb) {
      state.peerLostCb = cb;
      return () => {
        if (state.peerLostCb === cb) state.peerLostCb = null;
      };
    }
  };
}
