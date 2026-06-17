/**
 * @file The typed `Wire` channel + DataChannel mechanics — chunking/reassembly, backpressure, the
 * mandatory app-layer heartbeat, the open-timeout retry, and per-app teardown.
 * @see README.md
 *
 * `channel.ts` owns the `Wire` (contracts section 2) and the internal chunk envelope. Inbound frames are
 * reassembled then dispatched DIRECTLY to the single `Wire.on` consumer — never through Moku `emit`
 * (spec/07 section 3). `tearDownState` is the single teardown sequence both `onStop` and the public
 * `close()` API run against the same per-app `TransportState`.
 */
import type { PeerId, Wire } from "../../contracts";
import type { TransportConfig, TransportState } from "./types";

/**
 * One chunk of a serialized frame that exceeded `maxMessageBytes`. Reassembled by `id` before the frame
 * is delivered to the `Wire.on` consumer (contracts section 2.3). Plain-JSON so it crosses any
 * DataChannel. Transport-internal — below the `Wire` surface, not a contracts type.
 *
 * @example
 * ```ts
 * const env: ChunkEnvelope = { id: "g_1", seq: 0, total: 3, body: "{\"t\":\"sync-snap\"" };
 * ```
 */
export type ChunkEnvelope = {
  /** Stable group id (crypto-random) shared by all chunks of one frame. */
  readonly id: string;
  /** Zero-based index of this chunk. */
  readonly seq: number;
  /** Total chunk count for this group. */
  readonly total: number;
  /** This chunk's slice of the UTF-8 JSON body. */
  readonly body: string;
};

/**
 * Builds the stable per-app `Wire` (contracts section 2). `send`/`broadcast` serialize a `Frame` to JSON,
 * chunk it if it exceeds `cfg.maxMessageBytes`, and write to the peer's DataChannel respecting
 * `bufferedAmount` backpressure. `on` registers the single inbound-frame consumer (stored on
 * `state.frameConsumer`); inbound frames are reassembled and dispatched directly to it — `ping`/`pong`
 * are handled internally and never forwarded.
 *
 * @param state - The per-app transport state holding the peer map and frame consumer.
 * @param cfg - The transport config (chunk threshold).
 * @example
 * ```ts
 * const wire = createWire(state, cfg);
 * wire.broadcast({ t: "ping", ts: Date.now() });
 * ```
 */
export function createWire(state: TransportState, cfg: TransportConfig): Wire {
  throw new Error("not implemented");
}

/**
 * Starts the mandatory app-layer heartbeat loop (`setInterval(cfg.heartbeatIntervalMs)`): broadcasts a
 * `ping` to every connected peer and declares any peer with no `pong` for `cfg.heartbeatTimeoutMs` dead,
 * which disconnects it and emits `room:network-warning { reason: "channel-closed" }` (de-duped via
 * `state.warned`). Required because WebKit bug 303052 suppresses `RTCDataChannel.onclose` on iOS. Stores
 * the interval id on `state.heartbeatTimer`.
 *
 * @param state - The per-app transport state holding the peer map and heartbeat timer.
 * @param cfg - The transport config (ping interval, dead timeout).
 * @param emitWarning - Callback to emit `room:network-warning` with a `channel-closed` reason.
 * @throws {Error} Always — skeleton stub.
 * @example
 * ```ts
 * startHeartbeat(state, cfg, reason => ctx.emit("room:network-warning", { reason }));
 * ```
 */
export function startHeartbeat(
  state: TransportState,
  cfg: TransportConfig,
  emitWarning: (reason: "channel-closed") => void
): void {
  throw new Error("not implemented");
}

/**
 * Disconnects a single peer: clears its open/retry timers, closes its `RTCDataChannel` +
 * `RTCPeerConnection`, drops its reassembly buffers, and removes it from `state.peers`. Idempotent — a
 * no-op if the peer is already gone. Shared by the public `disconnect` API and the heartbeat dead-peer
 * path.
 *
 * @param state - The per-app transport state holding the peer map.
 * @param peerId - The peer to tear down.
 * @throws {Error} Always — skeleton stub.
 * @example
 * ```ts
 * disconnectPeer(state, "p_ab12");
 * ```
 */
export function disconnectPeer(state: TransportState, peerId: PeerId): void {
  throw new Error("not implemented");
}

/**
 * Tears down ALL of one app's live resources: stops the heartbeat interval, clears each peer's open/retry
 * timers, closes every channel + peer connection, drops every reassembly buffer, and leaves the signaling
 * session (contracts section 1.2). The single teardown sequence both `onStop` (via the registry lookup)
 * and the public `close()` API run against the same per-app `TransportState`. Idempotent.
 *
 * @param state - The per-app transport state to release.
 * @example
 * ```ts
 * await tearDownState(state);
 * ```
 */
export function tearDownState(state: TransportState): Promise<void> {
  throw new Error("not implemented");
}
