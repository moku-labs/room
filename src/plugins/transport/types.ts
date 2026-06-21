/**
 * @file Transport plugin types — config, state, API, and the per-peer connection record.
 * @see README.md
 *
 * Holds ONLY transport's internal types. The shared wire/signaling contracts (`Wire`, `Frame`,
 * `PeerId`, `Signaling`, `SignalingSession`) are imported from the central `../../contracts` module
 * (D16) — never re-declared or re-exported here.
 */
import type { Frame, PeerId, Signaling, SignalingSession, Wire } from "../../contracts";

/**
 * `transportPlugin` configuration. Tunes the WebRTC + DataChannel transport floor. Every timing default
 * is overridable so the iOS-Safari to Sony-Bravia interop spike (v1 GATE) can adjust per real-device
 * measurement. Applied via the typed `DEFAULT_TRANSPORT_CONFIG` const (no inline `as`; R6).
 *
 * @example
 * ```ts
 * // Default (public rendezvous, STUN on):
 * const cfg: Partial<TransportConfig> = {}; // all defaults
 *
 * // LAN-only, no STUN, deterministic tests:
 * const test: Partial<TransportConfig> = { signaling: inMemory(), iceServers: [] };
 * ```
 */
export type TransportConfig = {
  /**
   * The signaling seam implementation (contracts section 1, D12). Brokers the one-time SDP/ICE
   * handshake, then is discarded once the channel is `connected` (contracts section 1.2). Default:
   * `publicRendezvous()`.
   */
  signaling: Signaling;
  /**
   * ICE servers passed to every `RTCPeerConnection`. Default: a single public STUN
   * (`stun.l.google.com:19302`) — recommended even on-LAN for the iOS-Private-Relay / NAT edge (D11).
   * Override to `[]` to force LAN-only (mDNS host candidates). No TURN is ever added — strict no-server
   * (D2).
   */
  iceServers: readonly RTCIceServer[];
  /**
   * App-layer heartbeat ping interval in ms. Default `2000`. A `ping` is sent to every connected peer
   * every `heartbeatIntervalMs`; the peer echoes a `pong` (contracts section 2.4). MANDATORY — WebKit
   * bug 303052.
   */
  heartbeatIntervalMs: number;
  /**
   * Dead-peer timeout in ms. Default `6000`. A peer with no `pong` for `heartbeatTimeoutMs` is declared
   * dead, emits `room:network-warning { reason: "channel-closed" }`, and is removed from the roster
   * (contracts section 2.4, section 6). Must be a small multiple of `heartbeatIntervalMs`.
   */
  heartbeatTimeoutMs: number;
  /**
   * DataChannel-open timeout in ms before retrying the handshake. Default `3000`. If a freshly-created
   * channel does not `open` within `openTimeoutMs`, transport tears the half-open `RTCPeerConnection`
   * down and re-initiates the handshake over the SAME signaling session (the iOS-to-Bravia mitigation).
   * Capped retry count avoids an infinite loop, then `room:network-warning { reason: "ice-failed" }`.
   */
  openTimeoutMs: number;
  /**
   * Chunk threshold in bytes (UTF-8). Default `14336` (~14 KiB). A serialized `Frame` whose byte length
   * exceeds this is split into ordered chunks and reassembled on the receiver (contracts section 2.3).
   * Kept below the ~16 KiB safe cross-browser cap (Chrome silently closes above ~256 KiB).
   */
  maxMessageBytes: number;
};

/**
 * Per-peer live connection record. One per `RTCPeerConnection` in the star. Holds the DOM handles and
 * the heartbeat bookkeeping for a single peer. NEVER synced or persisted (non-serializable handles).
 *
 * @example
 * ```ts
 * const record: PeerConnection = {
 *   peerId: "p_ab12",
 *   pc: new RTCPeerConnection(),
 *   channel: null,
 *   state: "connecting",
 *   lastPongAt: Date.now(),
 *   paused: false,
 *   reassembly: new Map(),
 *   openTimer: null,
 *   retries: 0
 * };
 * ```
 */
export type PeerConnection = {
  /** Stable peer id on both planes (contracts section 6 `PeerId`). */
  peerId: PeerId;
  /** The live `RTCPeerConnection`. */
  pc: RTCPeerConnection;
  /** The single ordered/reliable gameplay `RTCDataChannel`. `null` until `open`. */
  channel: RTCDataChannel | null;
  /** Coarse lifecycle state used by retry/heartbeat logic. */
  state: "connecting" | "connected" | "retrying" | "dead";
  /** Epoch-ms of the last received `pong` (or channel-open). Drives the ~6 s dead timeout (section 2.4). */
  lastPongAt: number;
  /** Whether sends to this peer are paused for backpressure (`bufferedAmount` > ~64 KiB; section 2.4). */
  paused: boolean;
  /** In-flight chunk reassembly buffers keyed by chunk-group `id` (section 2.3). */
  reassembly: Map<string, ReassemblyBuffer>;
  /** DataChannel-open timeout handle (~3 s); cleared on `open`, on retry, and on teardown. `null` when idle. */
  openTimer: ReturnType<typeof setTimeout> | null;
  /**
   * Count of open-timeout handshake retries already attempted for this peer. Survives the delete +
   * recreate across a retry (re-stamped in `handlePeerArrival`) so the retry is capped at
   * `MAX_OPEN_RETRIES` instead of looping forever (the iOS-to-Bravia GATE mitigation).
   */
  retries: number;
};

/**
 * Receiver-side accumulator for an in-flight chunk group (one per `ChunkEnvelope.id`). Transport-internal
 * (below the `Wire` surface); assembled when all `total` parts arrive, then `JSON.parse`d and delivered.
 *
 * @example
 * ```ts
 * const buf: ReassemblyBuffer = { total: 3, parts: [undefined, undefined, undefined], received: 0 };
 * ```
 */
export type ReassemblyBuffer = {
  /** Total chunks expected. */
  readonly total: number;
  /** Received chunk bodies indexed by `seq`; assembled when all `total` arrive. */
  readonly parts: (string | undefined)[];
  /** Count of received parts — when it equals `total`, concatenate + `JSON.parse` + deliver. */
  received: number;
};

/**
 * Internal mutable state for `transportPlugin`. Holds live WebRTC handles, the active signaling session,
 * the heartbeat/open timers, and the single inbound-frame consumer registered via `Wire.on`. Per-app via
 * `ctx.state` — NEVER a module-level singleton (D14).
 *
 * @example
 * ```ts
 * const state: TransportState = {
 *   role: "idle",
 *   selfId: "",
 *   peers: new Map(),
 *   session: null,
 *   heartbeatTimer: null,
 *   frameConsumers: new Set(),
 *   warned: new Set()
 * };
 * ```
 */
export type TransportState = {
  /** Whether this peer is the authoritative host (star hub) or a controller (single edge). Set on connect. */
  role: "host" | "controller" | "idle";
  /** This peer's stable signaling/wire id (contracts section 6). Minted by the caller (session) on connect. */
  selfId: PeerId;
  /** All live peer connections keyed by `peerId`. Host: up to 8 entries; controller: up to 1 (the host). */
  peers: Map<PeerId, PeerConnection>;
  /** The open `SignalingSession` while gathering peers; `null` after `leave()` (contracts section 1.2). */
  session: SignalingSession | null;
  /** Interval-timer id for the heartbeat ping loop; `null` when no peers are connected. */
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  /**
   * The set of inbound-frame consumers registered via `Wire.on`. Room composes MULTIPLE engines on the
   * one shared `Wire` — `sync` (sync-snap/sync-delta), `intent` (intent), and `session` (recovery-*) each
   * register their own consumer and self-filter by `frame.t` (the tags are disjoint). Every reassembled
   * frame is fanned out to ALL consumers, so a later `Wire.on` never clobbers an earlier one (the prior
   * single-slot design silently dropped every consumer but the last). `Wire.on`'s unsubscribe removes just
   * that consumer; teardown clears the set.
   */
  frameConsumers: Set<(peerId: PeerId, frame: Frame) => void>;
  /**
   * Single consumer notified once when a peer's gameplay channel reaches open/usable. Set by session via
   * `onPeerConnected`; `null` when unset. Single-slot — only `sessionPlugin` registers it (unlike `frameConsumers`, which fans out), so latest registration wins.
   */
  peerConnectedCb: ((peerId: PeerId) => void) | null;
  /**
   * Single consumer notified when an ESTABLISHED peer is lost via the heartbeat dead-peer path (§2.4).
   * NOT fired on teardown/close/explicit disconnect. Set by session via `onPeerLost`; `null` when unset.
   * Single-slot — only `sessionPlugin` registers it (unlike `frameConsumers`, which fans out), so latest registration wins.
   */
  peerLostCb: ((peerId: PeerId) => void) | null;
  /** Per-reason de-dup guard so a given `room:network-warning` reason is emitted at most once per peer-epoch. */
  warned: Set<string>;
};

/**
 * Arguments to {@link TransportApi.connect}. `role` selects host (active offerer, star hub) vs controller
 * (passive answerer, single edge — contracts section 1 `SignalingJoinOpts.passive`).
 *
 * @example
 * ```ts
 * const opts: ConnectOpts = { role: "host", selfId: "host_root", code: "K7M2QX" };
 * ```
 */
export type ConnectOpts = {
  /** This peer's role in the star (contracts section 6). */
  readonly role: "host" | "controller";
  /** This peer's stable id (contracts section 6 `PeerId`), minted by `sessionPlugin`. */
  readonly selfId: PeerId;
  /** The 6-char room code that scopes the rendezvous (contracts section 6.2). */
  readonly code: string;
  /**
   * (`serverSignaling` host reload only) The DO-issued reclaim token persisted across the reload,
   * threaded into `Signaling.join` so the warm Durable Object re-binds this host instead of opening a
   * fresh room (contracts §1.3, §5.1, D25). Omitted on a normal host/controller connect and ignored by
   * `publicRendezvous`/`inMemory` (no DO to reclaim).
   */
  readonly reclaimToken?: string;
};

/**
 * Public API of `transportPlugin`. The networking floor every other Room plugin builds on. `connect`
 * opens connections on demand (session create/join); `wire()` hands the typed channel to the engines;
 * `disconnect`/`close` tear down. Gameplay rides `Wire` — NEVER Moku `emit` (contracts three planes).
 *
 * @example
 * ```ts
 * await app.transport.connect({ role: "host", selfId: "host_root", code: "K7M2QX" });
 * const wire = app.transport.wire();
 * wire.broadcast({ t: "ping", ts: Date.now() });
 * ```
 */
export type TransportApi = {
  /**
   * Opens the transport for this peer: joins the signaling room (contracts section 1) and, for a host,
   * begins accepting controller offers (active offerer); for a controller, waits to be offered to
   * (passive). Idempotent per `code`. Resolves once the signaling session is live (NOT once peers
   * connect — peer arrival is asynchronous and surfaced via the `Wire`). Stays joined until each channel
   * is `connected`, then leaves per contracts section 1.2.
   *
   * @param opts - Role, self id, and 6-char room code.
   * @returns A promise that resolves when the signaling session is established.
   * @throws {Error} If the signaling adapter cannot reach any rendezvous relay (also emits
   *   `room:network-warning { reason: "rendezvous-unreachable" }`).
   * @example
   * ```ts
   * await app.transport.connect({ role: "host", selfId: "host_root", code: "K7M2QX" });
   * ```
   */
  connect(opts: ConnectOpts): Promise<void>;

  /**
   * Returns the typed `Wire` (contracts section 2) for sending/broadcasting frames and registering the
   * single inbound-frame handler. The same `Wire` instance is returned every call (stable identity). On
   * a controller, `send`/`broadcast` collapse to "send to host"; on a host, `peerId` selects a controller.
   *
   * @returns The plugin's stable `Wire` instance.
   * @example
   * ```ts
   * const wire = app.transport.wire();
   * const off = wire.on((peerId, frame) => dispatchByTag(peerId, frame));
   * ```
   */
  wire(): Wire;

  /**
   * Tears down the connection to a single peer: closes its `RTCDataChannel` + `RTCPeerConnection`, clears
   * its reassembly/backpressure state, and removes it from the roster of live peers. Used when a
   * controller leaves cleanly or after the heartbeat declares it dead. Idempotent.
   *
   * @param peerId - The peer to disconnect.
   * @returns Nothing.
   * @example
   * ```ts
   * app.transport.disconnect("p_ab12");
   * ```
   */
  disconnect(peerId: PeerId): void;

  /**
   * Returns the ids of all currently-connected peers (channel `open` + heartbeat-alive). Host: the live
   * controllers; controller: `[hostId]` or `[]`. Read-only snapshot — consumers must not mutate it.
   *
   * @returns The connected peer ids.
   * @example
   * ```ts
   * for (const id of app.transport.peers()) wire.send(id, frame);
   * ```
   */
  peers(): readonly PeerId[];

  /**
   * Closes ALL peer connections (clearing each peer's open timer + reassembly), stops the
   * heartbeat loop, and leaves the signaling session. Exposed for an explicit room teardown without
   * stopping the app. `onStop` performs the same teardown work against this app's `TransportState`
   * (reached via the per-instance teardown registry keyed by `ctx.global`). Idempotent.
   *
   * @returns A promise that resolves once every connection and the signaling session are released.
   * @example
   * ```ts
   * await app.transport.close();
   * ```
   */
  close(): Promise<void>;

  /**
   * Registers the single consumer fired once when a peer's gameplay `RTCDataChannel` reaches
   * open/usable — a controller connected (on the host side) or the host connected (on the controller
   * side). Latest registration wins (same as `Wire.on`). Used by `sessionPlugin` to emit
   * `room:peer-joined` and update its roster.
   *
   * @param cb - Callback invoked with the connected peer's id.
   * @returns An unsubscribe function; calling it clears the consumer only if this registration is
   *   still the active one.
   * @example
   * ```ts
   * const off = app.transport.onPeerConnected(peerId => roster.add(peerId));
   * // Later:
   * off();
   * ```
   */
  onPeerConnected(cb: (peerId: PeerId) => void): () => void;

  /**
   * Returns the DO-issued host re-entry token from the active `serverSignaling` session's
   * `join-ack`/`reclaim-ack` (contracts §1.3), or `null` for non-server adapters and before/after a live
   * session. `sessionPlugin` reads it after `connect()` resolves and persists it in the
   * `HostReentryRecord`, then feeds it back via {@link ConnectOpts.reclaimToken} on host-reload re-entry
   * so the warm DO re-binds the host (§5.1, D25).
   *
   * @returns The persistent session's reclaim token, or `null` when there is none.
   * @example
   * ```ts
   * await app.transport.connect({ role: "host", selfId, code });
   * const token = app.transport.reclaimToken(); // persist for host-reload re-entry
   * ```
   */
  reclaimToken(): string | null;

  /**
   * Registers the single consumer fired when an ESTABLISHED peer is lost via the heartbeat dead-peer
   * path (§2.4). NOT fired on teardown, `close()`, or the public `disconnect()` API — heartbeat death
   * is the only trigger. Latest registration wins. Used by `sessionPlugin` to emit `room:peer-left`
   * and drive host-reload recovery.
   *
   * @param cb - Callback invoked with the lost peer's id.
   * @returns An unsubscribe function; calling it clears the consumer only if this registration is
   *   still the active one.
   * @example
   * ```ts
   * const off = app.transport.onPeerLost(peerId => roster.remove(peerId));
   * // Later:
   * off();
   * ```
   */
  onPeerLost(cb: (peerId: PeerId) => void): () => void;
};
