/**
 * Cross-cutting contract types for `@moku-labs/room` — the single physical home (D16) for every
 * shared signaling, wire, event, sync, and roster type. Pure types plus two consts, DOM-free by
 * construction so the signaling seam stays portable to `inMemory` (no `RTCPeerConnection`) and to
 * a future server-side adapter (Workers/Node build). Every plugin imports these from
 * `../../contracts`; they are never re-declared. Materializes specs/00-contracts.md §1–§6.
 *
 * @see ./index
 */

/* eslint-disable sonarjs/redundant-type-aliases -- PeerId/Namespace are spec-mandated domain aliases (00-contracts §4/§6); the named alias documents intent at every call site across the pack and is part of the public type surface. */

// ---------------------------------------------------------------------------
// §4 — Sync scalar/value model (D4) — foundational; referenced by §2 frames.
// ---------------------------------------------------------------------------

/** A JSON-serializable scalar/container value permitted in a synced cell (spec/11 §1.7). */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** A namespace identifier (a typed slice key, e.g. `"scores"`, `"round"`). */
export type Namespace = string;

// ---------------------------------------------------------------------------
// §6 — Roster / peer / room-code model (owned by `session/lifecycle/*`).
// ---------------------------------------------------------------------------

/** A peer's stable identity on both the signaling (§1) and wire (§2) planes. Plain string id. */
export type PeerId = string;

/**
 * A roster entry for one connected controller. The `id` is stable for the whole session; the
 * `reconnectToken` is persisted ON THE PHONE (localStorage) so a controller reload re-attaches to
 * the same logical slot. Plain-JSON (spec/11 §1.7) so it rides §2 and persists cleanly.
 */
export type RosterEntry = {
  /** Stable per-controller id (see {@link PeerId}). */
  readonly id: PeerId;
  /** Phone-persisted token that re-binds a reloaded controller to the same roster slot. */
  readonly reconnectToken: string;
  /** Optional human-facing display name the controller supplied (game-defined, JSON). */
  readonly name?: string;
  /** Epoch-ms timestamp the entry last had a live channel / heartbeat (§2.4). */
  readonly joinedAt: number;
};

/** The maximum number of simultaneous controllers (excludes the host). 8-cap (D11). */
export const MAX_CONTROLLERS = 8;

/** Number of characters in a room code (§6.2). */
export const ROOM_CODE_LENGTH = 6;

// ---------------------------------------------------------------------------
// §4 — Sync snapshot + op-list codec shapes (need {@link JsonValue}).
// ---------------------------------------------------------------------------

/**
 * The complete authoritative state: a map of namespace → (key → JSON cell). Sent whole in a
 * {@link SyncSnapshotFrame} on join / late-join / reconcile. Every leaf is a {@link JsonValue}.
 */
export type Snapshot = {
  readonly [ns: Namespace]: { readonly [key: string]: JsonValue };
};

/**
 * One namespaced cell write — the unit of the custom op-list codec (D4). O(changed-keys), trivially
 * typed, far lighter than RFC 6902 JSON Patch. `val: null` doubles as the delete marker for a cell.
 * Encoded/decoded in pure `codec.ts`; carried in batches inside a {@link SyncDeltaFrame}.
 */
export type Op = {
  /** Target namespace (slice). */
  readonly ns: Namespace;
  /** Target key within the namespace. */
  readonly key: string;
  /** New JSON value for the cell; `null` deletes the cell. */
  readonly val: JsonValue;
};

// ---------------------------------------------------------------------------
// §1 — The `Signaling` adapter seam (D12), DOM-free.
// ---------------------------------------------------------------------------

/**
 * Plain, DOM-free mirror of the browser `RTCIceCandidateInit` dictionary.
 * Declared locally (NOT imported from `lib.dom`) so the signaling contract is portable to
 * `inMemory` (no `RTCPeerConnection`) and to a future server-side adapter (Workers/Node build).
 * Field semantics match the WebRTC spec; `transport/channel.ts` passes these straight into
 * `pc.addIceCandidate()` on the browser side.
 */
export type IceCandidateInit = {
  /** The SDP candidate attribute string (e.g. `"candidate:..."`). Empty string is a valid end-of-candidates marker. */
  readonly candidate?: string;
  /** Media-stream identification tag this candidate is associated with, or `null`. */
  readonly sdpMid?: string | null;
  /** Index (zero-based) of the m-line this candidate is associated with, or `null`. */
  readonly sdpMLineIndex?: number | null;
  /** Username fragment (ICE ufrag) the candidate is associated with, or `null`. */
  readonly usernameFragment?: string | null;
};

/**
 * A single message exchanged over the signaling plane during the one-time WebRTC handshake.
 * Plain-JSON / structural by construction (no DOM types), so `inMemory` can pass it through
 * in-process and a server adapter can serialize it untouched. Carries ONLY handshake data —
 * never gameplay.
 */
export type SignalMsg =
  | {
      /** SDP offer or answer. */
      readonly kind: "offer" | "answer";
      /** The serialized SDP blob (`RTCSessionDescription.sdp`). */
      readonly sdp: string;
    }
  | {
      /** A trickle-ICE candidate. */
      readonly kind: "candidate";
      /** The DOM-free candidate payload (see {@link IceCandidateInit}). */
      readonly candidate: IceCandidateInit;
    };

/**
 * Options passed to `Signaling.join`.
 */
export type SignalingJoinOpts = {
  /** This peer's stable identifier on the signaling plane (see §6 {@link PeerId}). */
  readonly selfId: string;
  /**
   * When `true`, this peer joins WITHOUT initiating offers — it waits to be offered to
   * (the controller/answerer side of the star). When `false`/omitted, this peer is an
   * active offerer (the host/stage, which offers to each controller). The host is the
   * authoritative star hub; controllers are passive. See §6 (star topology).
   */
  readonly passive?: boolean;
  /**
   * (`serverSignaling` only) The DO-issued host re-entry token from a PRIOR `join-ack`, persisted by
   * `session` across a host reload (§5.1). When present, `serverSignaling` sends a `{kind:"reclaim",…}`
   * envelope (§1.3) INSTEAD of `{kind:"join"}`, so the warm Durable Object re-binds this host to the
   * existing room (controllers re-handshake) rather than spinning up a fresh, empty room. Ignored by
   * `publicRendezvous`/`inMemory` (they have no DO to reclaim) — they perform a normal join (D25).
   */
  readonly reclaimToken?: string;
};

/**
 * A live signaling session scoped to ONE room code. Created by `Signaling.join`. Brokers the
 * out-of-band SDP/ICE handshake for every peer in the room, then is discarded (see §1.2 lifecycle
 * rule).
 */
export type SignalingSession = {
  /**
   * Registers a callback fired when a peer appears in the room (after the adapter has matched it).
   * For the active (offerer) side this is the cue to create an offer for `peerId`.
   *
   * @param cb - Invoked with the newly-present peer's id.
   */
  onPeer(cb: (peerId: string) => void): void;

  /**
   * Registers a callback fired when a peer leaves / disappears from the signaling room.
   * Used only for handshake bookkeeping — dead-peer detection for ESTABLISHED channels is the
   * app-layer heartbeat's job (§2.4), NOT this callback (Trystero #77 unclean leave/join;
   * WebKit 303052).
   *
   * @param cb - Invoked with the departed peer's id.
   */
  onPeerLeave(cb: (peerId: string) => void): void;

  /**
   * Sends one handshake message to a specific peer over the signaling plane.
   *
   * @param peerId - The recipient peer's id.
   * @param msg - The offer/answer/candidate to deliver (see {@link SignalMsg}).
   */
  send(peerId: string, msg: SignalMsg): void;

  /**
   * Registers the inbound handshake handler. `transport/channel.ts` applies each `SignalMsg` to the
   * matching `RTCPeerConnection` (setRemoteDescription / addIceCandidate / createAnswer).
   *
   * @param cb - Invoked with `(senderPeerId, msg)` for every inbound handshake message.
   */
  onSignal(cb: (peerId: string, msg: SignalMsg) => void): void;

  /**
   * Tears down the signaling session and releases all rendezvous resources (relays, sockets,
   * sub-rooms). Idempotent. See §1.2 for WHEN the caller is permitted to call this.
   *
   * @returns A promise that resolves once the session resources are released.
   */
  leave(): Promise<void>;

  /**
   * (serverSignaling only) Registers a callback fired when the server signals imminent room teardown
   * (`ServerEnvelope {kind:"evict"}`, §1.3) — the DO is about to TTL-`deleteAll()`. `transport/handlers.ts`
   * registers this and emits `room:network-warning {reason:"room-evicted"}` (§3.1) so the UI warns instead
   * of silently re-handshaking — the adapter itself has no `ctx.emit`. No-op for `publicRendezvous`/
   * `inMemory` (they never call it).
   *
   * @param cb - Invoked once when the session learns the room is being evicted.
   */
  onEvict?(cb: () => void): void;

  /**
   * When `true`, this session MUST persist after the WebRTC DataChannel reaches `connected`
   * (transport does NOT call `leave()` post-ICE). Set ONLY by `serverSignaling`: the WS stays open
   * as the in-band discovery-push channel and the host-reload reclaim conduit. Absent/`false` for
   * `publicRendezvous`/`inMemory` ⇒ unchanged "leave once connected" lifecycle (§1.2, D25).
   */
  readonly persistent?: true;

  /**
   * (`serverSignaling` only) The DO-issued host re-entry token carried in the `join-ack`/`reclaim-ack`
   * (§1.3). `session` reads it after `connect()` (via `transport.reclaimToken()`), persists it in the
   * `HostReentryRecord`, and feeds it back through {@link SignalingJoinOpts.reclaimToken} on the next
   * host-reload `join` — completing the host-reclaim conduit (§5.1, D25). Absent for
   * `publicRendezvous`/`inMemory` (no DO ⇒ no token); host reload there falls back to a fresh room.
   */
  readonly reclaimToken?: string;
};

/**
 * The general room-based peer-signaling seam (D12). One method: `join` a room code, get a session.
 * Adapters: `publicRendezvous` (default, Trystero), `inMemory` (tests), and a FUTURE
 * `serverSignaling` — all interchangeable behind this type, requiring ZERO transport-plugin changes
 * to swap.
 */
export type Signaling = {
  /**
   * Joins the signaling room identified by `code` and returns a live session.
   *
   * @param code - The 6-char room code (see §6) that scopes the rendezvous.
   * @param opts - Self id + passive/active role (see {@link SignalingJoinOpts}).
   * @returns A promise resolving to the live {@link SignalingSession}.
   */
  join(code: string, opts: SignalingJoinOpts): Promise<SignalingSession>;
};

// ---------------------------------------------------------------------------
// §1.3 — Server protocol envelopes (sibling unions to `SignalMsg`, DOM-free).
// The persistent client↔Durable-Object WebSocket protocol for `serverSignaling`
// (D21/D23). NOT merged into `SignalMsg` (preserves its handshake-only invariant);
// the `relay` variant CARRIES a `SignalMsg`. Single home in this file (D16) so the
// `inMemory` adapter can simulate the full server path before a real DO exists.
// ---------------------------------------------------------------------------

/**
 * Client → Durable-Object control + relay frames on the persistent `serverSignaling` WebSocket.
 * DOM-free / plain-JSON so the DO (workerd) and the `inMemory` simulator both handle it untouched.
 * The `relay` variant carries a §1 {@link SignalMsg} — the DO never inspects gameplay (D2/D21).
 */
export type ClientEnvelope =
  | { readonly kind: "join"; readonly selfId: PeerId; readonly role: "host" | "controller" }
  | { readonly kind: "reclaim"; readonly selfId: PeerId; readonly reclaimToken: string }
  | { readonly kind: "relay"; readonly to: PeerId; readonly msg: SignalMsg };

/**
 * Durable-Object → client control + relay frames. `peer-arrived` is the offerer cue (mirrors the
 * §1 `onPeer` callback); `relay` delivers another peer's {@link SignalMsg}; `evict` precedes the DO's
 * TTL `deleteAll()` and maps to `room:network-warning {reason:"room-evicted"}` (§3, D25).
 */
export type ServerEnvelope =
  | { readonly kind: "join-ack"; readonly peers: readonly PeerId[]; readonly reclaimToken: string }
  | { readonly kind: "peer-arrived"; readonly peerId: PeerId; readonly role: "host" | "controller" }
  | { readonly kind: "peer-left"; readonly peerId: PeerId }
  | { readonly kind: "reclaim-ack"; readonly peers: readonly PeerId[] }
  | { readonly kind: "relay"; readonly from: PeerId; readonly msg: SignalMsg }
  | { readonly kind: "full" }
  | { readonly kind: "evict" }
  | { readonly kind: "error"; readonly code: number; readonly message: string };

// ---------------------------------------------------------------------------
// §2 — The typed `Wire` channel + `Frame` union (device↔host DataChannel).
// ---------------------------------------------------------------------------

/**
 * Controller → host typed input. Carries a controller sequence number for idempotent de-dup (§4.3);
 * the host drops any `cSeq <= lastApplied[peerId]`. Shape-checked only (D6 — no anti-cheat/HMAC).
 */
export type IntentFrame = {
  readonly t: "intent";
  /** Registered intent name (the intent contract key). */
  readonly name: string;
  /** Plain-JSON intent payload; validated by a correctness-only typed shape-check (D6). */
  readonly payload: unknown;
  /** Monotonic per-controller sequence number (§4.3). */
  readonly cSeq: number;
};

/**
 * Host → controller full authoritative snapshot. Sent on join, late-join, and reconnect/reconcile
 * (§5). Establishes the baseline `sSeq` the receiver applies deltas against.
 */
export type SyncSnapshotFrame = {
  readonly t: "sync-snap";
  /** The complete namespaced state at sequence `sSeq` (see §4.1 {@link Snapshot}). */
  readonly snapshot: Snapshot;
  /** Host sequence number this snapshot represents (§4.3). */
  readonly sSeq: number;
};

/**
 * Host → controller incremental op-list patch broadcast while live (throttled 20–30 Hz, §4).
 * Idempotent/ordered by `sSeq`; a controller that detects a gap requests a fresh snapshot.
 */
export type SyncDeltaFrame = {
  readonly t: "sync-delta";
  /** The changed cells since the previous `sSeq` (see §4.2 {@link Op}). */
  readonly ops: readonly Op[];
  /** Host sequence number AFTER applying these ops (§4.3). */
  readonly sSeq: number;
};

/** App-layer heartbeat ping (host↔controller). Drives dead-peer detection — WebKit 303052 (§2.4). */
export type HeartbeatPingFrame = {
  readonly t: "ping";
  /** Sender clock (epoch ms) for RTT/staleness; informational only. */
  readonly ts: number;
};

/** App-layer heartbeat pong reply, echoing the ping `ts`. */
export type HeartbeatPongFrame = {
  readonly t: "pong";
  /** Echoed `ts` from the corresponding {@link HeartbeatPingFrame}. */
  readonly ts: number;
};

/** Controller → host re-entry claim after a host reload (§5). Carries the persisted host token to verify. */
export type RecoveryHelloFrame = {
  readonly t: "recovery-hello";
  /** The `hostToken` the controller last saw, echoed back for peer-side verification (§5.2). */
  readonly hostToken: string;
  /** This controller's stable id + reconnect token (§6). */
  readonly peerId: PeerId;
};

/** Host → controller acknowledgement of a verified re-entry; precedes the reconcile snapshot (§5.3). */
export type RecoveryWelcomeFrame = {
  readonly t: "recovery-welcome";
  /** Confirms the host identity to the controller (matches the controller's stored token). */
  readonly hostToken: string;
  /** The host sequence the controller should reconcile against; a `sync-snap` follows. */
  readonly sSeq: number;
};

/**
 * Controller → host flush of intents buffered during a host absence (§5.3). The host applies them in
 * `cSeq` order, dropping any `cSeq <= lastApplied[peerId]` (idempotent reconcile).
 */
export type RecoveryFlushFrame = {
  readonly t: "recovery-flush";
  /** Timestamped, ordered intents buffered while the host was gone (§5.3). */
  readonly buffered: readonly { readonly intent: IntentFrame; readonly ts: number }[];
};

/**
 * Host → controller roster mirror (§6.1). Broadcast on every roster mutation (join/leave) so each
 * controller's `session.roster()` reflects the host-authoritative seat list. A DEDICATED frame — NOT a
 * `SyncSnapshotFrame` — so it never collides with the §4 sync replica plane: `syncPlugin` ignores it and
 * `sessionPlugin` applies it to its local roster mirror. (Sharing `sync-snap` would re-baseline — and so
 * wipe — a controller's game replica on every join/leave.)
 */
export type RosterFrame = {
  readonly t: "roster";
  /** The complete host-authoritative roster: controller {@link PeerId} → {@link RosterEntry} (§6.1). */
  readonly roster: { readonly [id: PeerId]: RosterEntry };
};

/**
 * The complete device↔host wire protocol. Discriminated on `t`. Every variant is plain-JSON; nothing
 * here flows through Moku `emit` (spec/07 §3, spec/11 §2.7).
 */
export type Frame =
  | IntentFrame
  | SyncSnapshotFrame
  | SyncDeltaFrame
  | HeartbeatPingFrame
  | HeartbeatPongFrame
  | RecoveryHelloFrame
  | RecoveryWelcomeFrame
  | RecoveryFlushFrame
  | RosterFrame;

/**
 * The typed device↔host DataChannel channel. Star topology: on the host (stage), `peerId` selects a
 * controller; on a controller, frames always target the single host so `send`/`broadcast` collapse to
 * "send to host". This is the ONLY transport for gameplay — Moku `emit` is reserved for §3 events.
 */
export type Wire = {
  /**
   * Sends one frame to a single peer over its DataChannel. Applies chunking (§2.3) and respects
   * backpressure (§2.4); resolves/queues per the channel's `bufferedAmount` state.
   *
   * @param peerId - Destination peer (see §6 {@link PeerId}).
   * @param frame - The typed frame to send (see {@link Frame}).
   */
  send(peerId: PeerId, frame: Frame): void;

  /**
   * Sends one frame to ALL currently-connected peers (host → every controller). No-op set on a
   * controller (it has only the host). Used for sync snapshots/deltas and heartbeat pings.
   *
   * @param frame - The typed frame to broadcast (see {@link Frame}).
   */
  broadcast(frame: Frame): void;

  /**
   * Registers the single inbound frame handler. Called once per fully-reassembled frame (§2.3),
   * with the sender's id. Transport dispatches each frame to the owning engine by `frame.t`
   * (intent → intentPlugin, sync-* → syncPlugin, ping/pong → heartbeat, recovery-* / roster →
   * sessionPlugin).
   *
   * @param handler - Invoked with `(senderPeerId, frame)` for every inbound frame.
   * @returns An unsubscribe function.
   */
  on(handler: (peerId: PeerId, frame: Frame) => void): () => void;
};

// ---------------------------------------------------------------------------
// §3 — The `room:*` event payloads (Moku `emit` — coarse lifecycle ONLY).
// ---------------------------------------------------------------------------

/**
 * Room's coarse lifecycle events on the Moku `emit` plane. Declared via the register-callback pattern
 * (spec/14 §2) by the engine that owns each. Facades re-declare/forward them (§3.3). These are the
 * ONLY events Room emits — all device↔host traffic is the §2 wire, never these.
 */
export type RoomEvents = {
  /** A controller's DataChannel reached `connected` and was added to the roster (§6). */
  "room:peer-joined": { peerId: PeerId };
  /** A controller left or was declared dead by the heartbeat (§2.4) and removed from the roster. */
  "room:peer-left": { peerId: PeerId };
  /** The host tab reloaded; recovery is in flight. Controllers should show "reconnecting" UX (§5). */
  "room:host-reconnecting": Record<string, never>;
  /** The first authoritative frame (snapshot, or gap-free delta) has been applied; replica readable (§4). */
  "room:sync-ready": Record<string, never>;
  /** A network condition surfaced to the consumer for failure UX (D2 accepted hard-failure). */
  "room:network-warning": {
    reason: "ice-failed" | "rendezvous-unreachable" | "channel-closed" | "room-evicted";
  };
};
