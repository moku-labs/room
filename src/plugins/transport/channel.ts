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
import type { Frame, HeartbeatPongFrame, PeerId, Wire } from "../../contracts";
import type { PeerConnection, TransportConfig, TransportState } from "./types";

/**
 * The minimal DataChannel surface the wire uses. Satisfied by a real browser `RTCDataChannel` AND by the
 * `inMemory` adapter's in-process loopback pipe — so the wire mechanics are identical on both paths and
 * the integration tests need no `RTCPeerConnection`.
 */
export type WireChannel = {
  /** Current buffered bytes awaiting the network; drives backpressure (contracts section 2.4). */
  bufferedAmount: number;
  /** Resume threshold for the `bufferedamountlow` event. */
  bufferedAmountLowThreshold: number;
  /** Whether the channel is open for sends. */
  readyState: string;
  /** Inbound message sink. */
  onmessage: ((event: { data: string }) => void) | null;
  /** Writes one serialized message to the peer. */
  send(data: string): void;
  /** Subscribes to a channel event (`bufferedamountlow` / `close`). */
  addEventListener(type: string, cb: () => void): void;
  /** Unsubscribes from a channel event. */
  removeEventListener(type: string, cb: () => void): void;
  /** Closes the channel. */
  close(): void;
};

/**
 * One end of an in-process loopback pipe (the `inMemory` adapter's `WireChannel`).
 *
 * Aliased for clarity: `WireChannel` is the minimal wire surface; `LoopbackEndpoint` signals that this
 * end is always the in-process pipe created by `inMemory`, never a real `RTCDataChannel`.
 *
 * @example
 * ```ts
 * const endpoint: LoopbackEndpoint = new PipeEndpoint();
 * endpoint.send(JSON.stringify({ t: "ping", ts: Date.now() }));
 * ```
 */
// eslint-disable-next-line sonarjs/redundant-type-aliases -- domain alias: LoopbackEndpoint clarifies the usage site (in-process pipe end, not a real DataChannel); removing it would collapse two distinct roles into one name
export type LoopbackEndpoint = WireChannel;

/**
 * Transport-internal capability a signaling session MAY expose to hand transport an already-open
 * in-process wire channel instead of negotiating WebRTC. Implemented by `inMemory` (tests); absent on
 * real adapters, which fall back to the `RTCPeerConnection` handshake.
 */
export type LoopbackSignaling = {
  /**
   * Returns an open loopback `WireChannel` to `peerId`, or `null` if the peer is not present on the bus.
   *
   * @param peerId - The remote peer to open an in-process channel to.
   * @returns The open loopback channel, or `null`.
   */
  openWireChannel(peerId: PeerId): WireChannel | null;
};

/** Backpressure high-water mark in bytes — pause sends to a peer above this (contracts section 2.4). */
const BACKPRESSURE_THRESHOLD_BYTES = 64 * 1024;

/** A chunk envelope on the wire (transport-internal — below the `Wire` surface, contracts section 2.3). */
type ChunkEnvelope = {
  readonly id: string;
  readonly seq: number;
  readonly total: number;
  readonly body: string;
};

/**
 * Computes the UTF-8 byte length of a string (the cap chunking measures against).
 *
 * @param value - The string to measure.
 * @returns The number of UTF-8 bytes the string encodes.
 * @example
 * ```ts
 * byteLength("hello"); // 5
 * ```
 */
function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * Type guard: a parsed wire message is a chunk envelope (has `id`, `seq`, `total`, `body`) rather than
 * a raw `Frame`. Used to route inbound messages to the reassembly path.
 *
 * @param value - The unknown parsed JSON value to test.
 * @returns `true` if the value matches the `ChunkEnvelope` shape.
 * @example
 * ```ts
 * const parsed = JSON.parse(raw);
 * if (isChunkEnvelope(parsed)) { reassemble(peer, parsed); }
 * ```
 */
function isChunkEnvelope(value: unknown): value is ChunkEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["id"] === "string" &&
    typeof record["seq"] === "number" &&
    typeof record["total"] === "number" &&
    typeof record["body"] === "string"
  );
}

/**
 * Splits a serialized frame into ordered `ChunkEnvelope`s sharing one crypto-random group `id`. Each
 * chunk body is a code-unit slice sized to `maxBytes / 2` so the JSON-encoded envelope stays well
 * below the DataChannel cap after wrapping.
 *
 * @param serialized - The JSON-serialized `Frame` to split.
 * @param maxBytes - The per-message byte cap from `TransportConfig.maxMessageBytes`.
 * @returns An ordered array of `ChunkEnvelope`s with the shared `id` and correct `total`.
 * @example
 * ```ts
 * const chunks = toChunks(JSON.stringify(bigFrame), 14336);
 * ```
 */
function toChunks(serialized: string, maxBytes: number): ChunkEnvelope[] {
  const id = crypto.randomUUID();
  const chunks: ChunkEnvelope[] = [];
  // Slice by code unit; envelope overhead keeps each well under the cap, and JSON escaping is unaffected
  // because reassembly concatenates the raw bodies before parsing.
  const sliceSize = Math.max(1, Math.floor(maxBytes / 2));
  for (let start = 0; start < serialized.length; start += sliceSize) {
    chunks.push({
      id,
      seq: chunks.length,
      total: 0,
      body: serialized.slice(start, start + sliceSize)
    });
  }
  const total = chunks.length;
  return chunks.map(chunk => ({ ...chunk, total }));
}

/**
 * Casts a `PeerConnection.channel` (typed as `RTCDataChannel | null`) to the minimal `WireChannel`
 * surface so channel mechanics work identically with both a real DataChannel and the loopback pipe.
 *
 * @param channel - The raw channel field from a `PeerConnection`.
 * @returns The channel as a `WireChannel`, or `null` if not yet assigned.
 * @example
 * ```ts
 * const ch = asWireChannel(peer.channel);
 * if (ch?.readyState === "open") ch.send(data);
 * ```
 */
function asWireChannel(channel: PeerConnection["channel"]): WireChannel | null {
  return channel as unknown as WireChannel | null;
}

/**
 * Writes a single serialized message to a peer, honoring per-peer backpressure (contracts section 2.4).
 * If the channel's `bufferedAmount` exceeds the high-water mark, pauses sends for this peer and queues
 * the message until the `bufferedamountlow` event fires, then drains the queue recursively.
 *
 * @param peer - The target peer connection record.
 * @param message - The already-serialized string to send (a `Frame` or `ChunkEnvelope`).
 * @param queue - Per-peer send queue, keyed by `peerId`, used during backpressure pauses.
 * @example
 * ```ts
 * writeToPeer(peer, JSON.stringify(frame), queues);
 * ```
 */
function writeToPeer(peer: PeerConnection, message: string, queue: Map<PeerId, string[]>): void {
  const channel = asWireChannel(peer.channel);
  if (!channel) return;
  if (channel.readyState !== "open") return;

  const pending = queue.get(peer.peerId);
  if (peer.paused || (pending && pending.length > 0)) {
    const buffer = pending ?? [];
    buffer.push(message);
    queue.set(peer.peerId, buffer);
    return;
  }

  if (channel.bufferedAmount > BACKPRESSURE_THRESHOLD_BYTES) {
    peer.paused = true;
    channel.bufferedAmountLowThreshold = BACKPRESSURE_THRESHOLD_BYTES / 2;
    queue.set(peer.peerId, [message]);
    /**
     * Drains the per-peer send queue once the channel's `bufferedamountlow` event fires.
     *
     * @example
     * ```ts
     * channel.addEventListener("bufferedamountlow", resume);
     * ```
     */
    const resume = (): void => {
      peer.paused = false;
      channel.removeEventListener("bufferedamountlow", resume);
      const drained = queue.get(peer.peerId) ?? [];
      queue.delete(peer.peerId);
      for (const queued of drained) writeToPeer(peer, queued, queue);
    };
    channel.addEventListener("bufferedamountlow", resume);
    return;
  }

  channel.send(message);
}

/**
 * Serializes a `Frame` to JSON, splits it into chunks if it exceeds `cfg.maxMessageBytes`, and writes
 * each serialized piece to the peer via `writeToPeer` (backpressure-aware).
 *
 * @param peer - The target peer connection record.
 * @param frame - The frame to serialize and send.
 * @param cfg - The transport config supplying `maxMessageBytes`.
 * @param queue - Per-peer send queue passed through to `writeToPeer` for backpressure handling.
 * @example
 * ```ts
 * sendFrame(peer, { t: "ping", ts: Date.now() }, cfg, queues);
 * ```
 */
function sendFrame(
  peer: PeerConnection,
  frame: Frame,
  cfg: TransportConfig,
  queue: Map<PeerId, string[]>
): void {
  const serialized = JSON.stringify(frame);
  if (byteLength(serialized) <= cfg.maxMessageBytes) {
    writeToPeer(peer, serialized, queue);
    return;
  }
  for (const envelope of toChunks(serialized, cfg.maxMessageBytes)) {
    writeToPeer(peer, JSON.stringify(envelope), queue);
  }
}

/**
 * Accumulates an inbound `ChunkEnvelope` into the per-peer reassembly buffer for its group `id`. Returns
 * the fully-assembled `Frame` once all `total` parts have arrived (deleting the buffer), or `null` while
 * chunks are still in-flight.
 *
 * @param peer - The peer whose `reassembly` map holds the in-flight buffer for this chunk group.
 * @param envelope - The inbound chunk envelope to accumulate.
 * @returns The completed, parsed `Frame` when every part has arrived; otherwise `null`.
 * @example
 * ```ts
 * const frame = reassemble(peer, envelope);
 * if (frame) deliver(state, peer, frame);
 * ```
 */
function reassemble(peer: PeerConnection, envelope: ChunkEnvelope): Frame | null {
  let buffer = peer.reassembly.get(envelope.id);
  if (!buffer) {
    buffer = { total: envelope.total, parts: Array.from({ length: envelope.total }), received: 0 };
    peer.reassembly.set(envelope.id, buffer);
  }
  if (buffer.parts[envelope.seq] === undefined) {
    buffer.parts[envelope.seq] = envelope.body;
    buffer.received += 1;
  }
  if (buffer.received < buffer.total) return null;
  peer.reassembly.delete(envelope.id);
  return JSON.parse(buffer.parts.join("")) as Frame;
}

/**
 * Wires a peer's channel `onmessage` to the reassembly + frame-consumer pipeline. Chunks are
 * accumulated via `reassemble`; complete frames are forwarded to `deliver` (which handles
 * `ping`/`pong` internally before reaching the consumer). No-op if the channel is not yet assigned.
 *
 * Uses the `onmessage` property (not `addEventListener`) because `WireChannel` is a minimal duck-type
 * that both `RTCDataChannel` and the in-process `PipeEndpoint` satisfy; the `onmessage` property is
 * the unified message sink for both paths and doubling as the idempotency sentinel in `ensureReceiving`.
 *
 * @param state - The per-app transport state (frame consumer, peer map).
 * @param peer - The peer whose channel's `onmessage` should be wired up.
 * @example
 * ```ts
 * attachReceive(state, peer);
 * ```
 */
function attachReceive(state: TransportState, peer: PeerConnection): void {
  const channel = asWireChannel(peer.channel);
  if (!channel) return;
  /**
   * Receives a raw DataChannel message event, routes it through reassembly, and dispatches the frame.
   *
   * @param event - The message event carrying the serialized frame or chunk envelope.
   * @param event.data - The raw serialized string received from the peer.
   * @example
   * ```ts
   * channel.onmessage = onMessage;
   * ```
   */
  // eslint-disable-next-line unicorn/prefer-add-event-listener -- WireChannel.onmessage is the unified message sink for both RTCDataChannel and the loopback PipeEndpoint; it doubles as the idempotency sentinel in ensureReceiving (null === not yet wired)
  channel.onmessage = (event: { data: string }): void => {
    const parsed = JSON.parse(event.data) as unknown;
    const frame = isChunkEnvelope(parsed) ? reassemble(peer, parsed) : (parsed as Frame);
    if (!frame) return;
    deliver(state, peer, frame);
  };
}

/**
 * Dispatches a fully-reassembled `Frame`: `ping` receives an immediate `pong` reply and updates
 * `lastPongAt`; `pong` updates `lastPongAt` only. Every other frame is forwarded to `state.frameConsumer`
 * (the handler registered via `Wire.on`).
 *
 * @param state - The per-app transport state holding the frame consumer.
 * @param peer - The peer that sent the frame (provides `lastPongAt` and channel for the pong reply).
 * @param frame - The fully-assembled, parsed frame to dispatch.
 * @example
 * ```ts
 * deliver(state, peer, { t: "game:move", payload: { x: 1 } });
 * ```
 */
function deliver(state: TransportState, peer: PeerConnection, frame: Frame): void {
  if (frame.t === "ping") {
    peer.lastPongAt = Date.now();
    const pong: HeartbeatPongFrame = { t: "pong", ts: frame.ts };
    const channel = asWireChannel(peer.channel);
    if (channel?.readyState === "open") channel.send(JSON.stringify(pong));
    return;
  }
  if (frame.t === "pong") {
    peer.lastPongAt = Date.now();
    return;
  }
  state.frameConsumer?.(peer.peerId, frame);
}

/**
 * Builds the stable per-app `Wire` (contracts section 2). `send`/`broadcast` serialize a `Frame` to JSON,
 * chunk it if it exceeds `cfg.maxMessageBytes`, and write to the peer's channel respecting `bufferedAmount`
 * backpressure. `on` registers the single inbound-frame consumer (stored on `state.frameConsumer`);
 * inbound frames are reassembled and dispatched directly to it — `ping`/`pong` are handled internally and
 * never forwarded.
 *
 * @param state - The per-app transport state holding the peer map and frame consumer.
 * @param cfg - The transport config (chunk threshold).
 * @returns The stable `Wire` instance for this app.
 * @example
 * ```ts
 * const wire = createWire(state, cfg);
 * wire.broadcast({ t: "ping", ts: Date.now() });
 * ```
 */
export function createWire(state: TransportState, cfg: TransportConfig): Wire {
  const queues = new Map<PeerId, string[]>();
  return {
    /** @inheritdoc */
    send(peerId, frame) {
      const peer = state.peers.get(peerId);
      if (peer) {
        ensureReceiving(state, peer);
        sendFrame(peer, frame, cfg, queues);
      }
    },
    /** @inheritdoc */
    broadcast(frame) {
      for (const peer of state.peers.values()) {
        ensureReceiving(state, peer);
        sendFrame(peer, frame, cfg, queues);
      }
    },
    /** @inheritdoc */
    on(handler) {
      state.frameConsumer = handler;
      for (const peer of state.peers.values()) ensureReceiving(state, peer);
      /**
       * Removes this handler from `state.frameConsumer` if it is still the active consumer.
       *
       * @example
       * ```ts
       * const off = wire.on(handler);
       * off(); // deregisters the handler
       * ```
       */
      return () => {
        if (state.frameConsumer === handler) state.frameConsumer = null;
      };
    }
  };
}

/**
 * Idempotently attaches the receive pump to a peer's channel. The first call to `send`, `broadcast`, or
 * `on` that reaches a peer with a live channel wires it up; subsequent calls are no-ops because
 * `attachReceive` sets `channel.onmessage` to a non-null handler, making the guard `=== null` false.
 *
 * @param state - The per-app transport state (frame consumer, peer map).
 * @param peer - The peer whose channel to wire up if not already wired.
 * @example
 * ```ts
 * ensureReceiving(state, peer);
 * ```
 */
function ensureReceiving(state: TransportState, peer: PeerConnection): void {
  const channel = asWireChannel(peer.channel);
  if (channel && channel.onmessage === null) attachReceive(state, peer);
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
  if (state.heartbeatTimer !== null) return;
  const queues = new Map<PeerId, string[]>();
  state.heartbeatTimer = setInterval(() => {
    const now = Date.now();
    for (const peer of state.peers.values()) {
      if (now - peer.lastPongAt > cfg.heartbeatTimeoutMs) {
        peer.state = "dead";
        const lostId = peer.peerId;
        disconnectPeer(state, lostId);
        if (!state.warned.has(`channel-closed:${lostId}`)) {
          state.warned.add(`channel-closed:${lostId}`);
          emitWarning("channel-closed");
        }
        state.peerLostCb?.(lostId);
        continue;
      }
      sendFrame(peer, { t: "ping", ts: now }, cfg, queues);
    }
  }, cfg.heartbeatIntervalMs);
}

/**
 * Disconnects a single peer: clears its open timer, closes its channel + `RTCPeerConnection`, drops its
 * reassembly buffers, clears its per-peer warn keys (so a same-id peer that reconnects then dies again
 * can warn afresh — once per peer-EPOCH, contracts section 6), and removes it from `state.peers`.
 * Idempotent — a no-op if the peer is already gone. Shared by the public `disconnect` API and the
 * heartbeat dead-peer path.
 *
 * @param state - The per-app transport state holding the peer map.
 * @param peerId - The peer to tear down.
 * @example
 * ```ts
 * disconnectPeer(state, "p_ab12");
 * ```
 */
export function disconnectPeer(state: TransportState, peerId: PeerId): void {
  const peer = state.peers.get(peerId);
  if (!peer) return;
  if (peer.openTimer !== null) clearTimeout(peer.openTimer);
  asWireChannel(peer.channel)?.close();
  peer.pc.close();
  peer.reassembly.clear();
  state.warned.delete(`channel-closed:${peerId}`);
  state.warned.delete(`ice-failed:${peerId}`);
  state.peers.delete(peerId);
}

/**
 * Tears down ALL of one app's live resources: stops the heartbeat interval, clears each peer's open
 * timer, closes every channel + peer connection, drops every reassembly buffer, and leaves the signaling
 * session (contracts section 1.2). The single teardown sequence both `onStop` (via the registry lookup)
 * and the public `close()` API run against the same per-app `TransportState`. Idempotent.
 *
 * @param state - The per-app transport state to release.
 * @returns A promise that resolves once every connection and the signaling session are released.
 * @example
 * ```ts
 * await tearDownState(state);
 * ```
 */
export async function tearDownState(state: TransportState): Promise<void> {
  if (state.heartbeatTimer !== null) {
    clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = null;
  }
  for (const peerId of state.peers.keys()) disconnectPeer(state, peerId);
  const session = state.session;
  state.session = null;
  state.frameConsumer = null;
  state.peerConnectedCb = null;
  state.peerLostCb = null;
  state.warned.clear();
  await session?.leave();
}

/**
 * Wires the receive pump on a freshly-connected peer. Called by `handlers.ts` immediately after a
 * DataChannel or loopback pipe is assigned to the peer record, so inbound frames start being delivered
 * to the `Wire.on` consumer.
 *
 * @param state - The per-app transport state (frame consumer, peer map).
 * @param peer - The peer whose channel should be wired to the receive pipeline.
 * @example
 * ```ts
 * bindPeerChannel(state, peer);
 * ```
 */
export function bindPeerChannel(state: TransportState, peer: PeerConnection): void {
  attachReceive(state, peer);
}
