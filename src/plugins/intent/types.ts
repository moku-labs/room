/**
 * Public + internal type contracts for the intent plugin.
 *
 * Carries the CONCRETE signatures from the spec: the role-agnostic {@link IntentApi}, the controller-side
 * buffer + retransmit {@link IntentConfig}, the correctness-only {@link IntentSchema} /
 * {@link IntentFieldRule} (D6), the at-least-once {@link IntentDelivery} tracker contract (§4.3),
 * and the per-app {@link IntentState}. Shared wire/roster types (`IntentFrame`, `PeerId`, `JsonValue`)
 * are imported from their owning plugins (`../transport/protocol` for the wire/signaling protocol; `RoomEvents` from `../../config`) — never re-declared here.
 *
 * @file
 * @see README.md
 */
import type { IntentFrame, JsonValue, PeerId } from "../transport/protocol";

/**
 * Configuration for the intent plugin.
 *
 * Governs the controller-side reconnect buffer (recovery contract) and the controller-side at-least-once
 * delivery window (retransmit contract, §4.3). There is no validation knob: shape-checking is
 * correctness-only and always on (D6 — no anti-cheat / rate-limit toggle would make sense in the trusted
 * living-room threat model). Flat config (no nesting).
 *
 * @example
 * ```ts
 * // Defaults — a 256-entry, 10-second buffer window; 1 s ack timeout, 3 bounded retransmits.
 * const cfg: IntentConfig = {
 *   bufferCap: 256,
 *   bufferMaxAgeMs: 10_000,
 *   ackTimeoutMs: 1000,
 *   maxRetransmits: 3
 * };
 * ```
 */
export type IntentConfig = {
  /**
   * Maximum number of timestamped intents the controller buffers during a host absence before the
   * OLDEST entries are discarded (FIFO drop). Bounds memory for high-frequency analog intents
   * (e.g. a tilt/joystick stream) when a host reload runs long. Lossy by design. Default `256`.
   * Doubles as the cap on the live delivery tracker's send queue (the intents waiting behind the
   * one in-flight unacked frame) — past it the OLDEST queued intent is dropped with its own
   * `room:intent-undeliverable`.
   */
  readonly bufferCap: number;
  /**
   * Maximum age, in milliseconds, a buffered intent is kept before it is pruned on the next enqueue
   * or drain. Should be `>=` the `sessionPlugin` reconnect timeout (~10 s) so the buffer never
   * out-lives the recovery window it feeds. Default `10_000`.
   */
  readonly bufferMaxAgeMs: number;
  /**
   * Milliseconds a live intent may sit unacked before its first retransmit; the wait DOUBLES after each
   * retransmit (1×, 2×, 4×, …), so the total silence budget is `ackTimeoutMs * (2^(maxRetransmits+1) - 1)`
   * (~15 s at the defaults). Must be `>= 1`. Default `1000`.
   */
  readonly ackTimeoutMs: number;
  /**
   * Maximum number of times the SAME unacked frame (same `cSeq` — safe under the host's §4.3 de-dup) is
   * re-sent before the wire is declared dead: the intent and everything queued behind it drop with one
   * `room:intent-undeliverable` each. Must be a non-negative integer (`0` = track + signal, never
   * re-send). Default `3`.
   */
  readonly maxRetransmits: number;
};

/**
 * A correctness-only field rule inside an {@link IntentSchema}. Each rule shape-checks one primitive
 * leaf. Bounds are inclusive. Anything beyond shape (auth, rate, replay) is out of scope (D6).
 */
export type IntentFieldRule =
  | {
      /** A numeric field. `min`/`max` are inclusive bounds (NaN / ±Infinity always fail). */
      readonly type: "number";
      /** Inclusive lower bound, if any. */
      readonly min?: number;
      /** Inclusive upper bound, if any. */
      readonly max?: number;
    }
  | {
      /** A string field. `maxLength` caps UTF-16 length to keep frames within the chunk budget. */
      readonly type: "string";
      /** Inclusive max length, if any. */
      readonly maxLength?: number;
    }
  | {
      /** A boolean field. */
      readonly type: "boolean";
    }
  | {
      /** A literal enum field — the value must be `===` one of `values`. */
      readonly type: "enum";
      /** The permitted literal values (plain-JSON scalars). */
      readonly values: readonly (string | number | boolean)[];
    };

/**
 * The correctness-only typed shape-check for one intent kind (D6). The host registers one per intent
 * name via `register()`. Validation is exactly: every required field present and matching its rule,
 * AND (when `additionalFields` is `false`) NO field outside `fields`. Plain object payloads only —
 * the top-level `IntentFrame.payload` must be a JSON object whose leaves match.
 *
 * @example
 * ```ts
 * const moveSchema: IntentSchema = {
 *   fields: {
 *     dx: { type: "number", min: -1, max: 1 },
 *     dy: { type: "number", min: -1, max: 1 },
 *     boost: { type: "boolean" }
 *   },
 *   additionalFields: false // reject any unknown field
 * };
 * ```
 */
export type IntentSchema = {
  /** The per-field rules keyed by field name. Every key is a REQUIRED field of the payload. */
  readonly fields: Readonly<Record<string, IntentFieldRule>>;
  /**
   * Whether fields outside `fields` are tolerated. `false` (the strict default intent) rejects any
   * unknown field — the "no unknown fields" rule. `true` allows extra ignored keys.
   */
  readonly additionalFields: boolean;
};

/** Metadata handed to a host {@link IntentHandler} alongside the validated payload. */
export type IntentMeta = {
  /** The controller that sent the intent. */
  readonly peerId: PeerId;
  /** The frame's per-controller sequence number — already de-duplicated when the handler runs. */
  readonly cSeq: number;
};

/**
 * A host intent handler. Runs ONLY after validation + de-dup pass. `payload` is the same runtime value
 * as the wire payload (the shape-check is structural, not a transform), narrowed only by convention to
 * the schema; consumers may cast to their own game type.
 *
 * @param payload - The validated plain-JSON payload.
 * @param meta - The sender + sequence metadata (see {@link IntentMeta}).
 */
export type IntentHandler = (payload: JsonValue, meta: IntentMeta) => void;

/**
 * One registered intent kind on the host: its correctness-only shape-check and its subscriber.
 * Stored per `name` in {@link IntentState.registry}. Controller instances never populate this map.
 */
export type IntentRegistration = {
  /** The correctness-only typed shape-check for this intent's payload (see {@link IntentSchema}). */
  readonly schema: IntentSchema;
  /** The host handler invoked with the validated, de-duplicated payload + sender (set by `onIntent`). */
  readonly handler: IntentHandler;
};

/**
 * One timestamped, queued intent held on the controller during a host absence (recovery contract).
 * Plain-JSON so `sessionPlugin` can ship the drained array straight inside a `RecoveryFlushFrame`
 * with no re-encoding.
 */
export type BufferedIntent = {
  /** The fully-formed, `cSeq`-stamped frame that would have been sent live. */
  readonly intent: IntentFrame;
  /** Epoch-ms enqueue time — drives `bufferMaxAgeMs` pruning and the host's ordered reconcile. */
  readonly ts: number;
};

/**
 * The controller-side at-least-once delivery tracker for LIVE intent sends (§4.3). Stop-and-wait: ONE
 * unacked frame in flight at a time, later intents queue behind it in `cSeq` order — forced by the
 * host's high-water-mark de-dup (if a newer `cSeq` ever applied first, a retransmitted older frame
 * would be `<= lastApplied` and silently eaten forever). Built once per app by `createIntentApi` and
 * shared via {@link IntentState.delivery}; the receive path routes inbound `intent-ack` frames to it,
 * and `onStop` reaches it to clear the retransmit timer.
 */
export type IntentDelivery = {
  /**
   * Tracks + transmits one live `IntentFrame`: sends immediately when nothing is in flight, otherwise
   * queues it (FIFO, `bufferCap`-capped — past the cap the OLDEST queued intent drops with its own
   * `room:intent-undeliverable`). Arms the bounded retransmit loop for the in-flight frame.
   *
   * @param frame - The fully-formed, `cSeq`-stamped frame to deliver at-least-once.
   */
  send(frame: IntentFrame): void;

  /**
   * Applies one inbound wire-level receipt. Releases the in-flight frame when `cSeq` matches it (then
   * promotes the next queued frame); any other receipt (stale, duplicate, unknown) is ignored.
   *
   * @param cSeq - The acknowledged frame's per-controller sequence number.
   */
  onAck(cSeq: number): void;

  /**
   * Recovery seam: atomically returns EVERY tracked frame (the in-flight one first, then the queue, in
   * `cSeq` order), clears the tracker, and cancels the retransmit timer. Called when buffering turns on
   * so the §5 reconnect buffer subsumes the live window during a known host absence — no
   * `room:intent-undeliverable` fires for retired frames.
   *
   * @returns The retired frames in `cSeq` order (empty when nothing was tracked).
   */
  retire(): readonly IntentFrame[];

  /**
   * Teardown (called from the plugin's `onStop` via the per-instance registry): cancels the retransmit
   * timer and drops all tracked frames SILENTLY (no terminal events at app stop). Idempotent.
   */
  stop(): void;
};

/**
 * Internal mutable state for the intent plugin. A single instance is role-agnostic (D5): the host
 * populates `registry` + `lastApplied`; the controller advances `nextCSeq` and fills `buffer` while
 * `buffering` is on. Unused halves simply stay empty for the other role.
 *
 * @example
 * ```ts
 * // Host mid-game, two controllers seen, one intent kind registered:
 * const host: IntentState = {
 *   registry: new Map([["move", { schema, handler }]]),
 *   lastApplied: new Map([["ctrl-a", 42], ["ctrl-b", 17]]),
 *   nextCSeq: 0, // host never sends intents
 *   buffering: false,
 *   buffer: [],
 *   delivery: null // host never tracks outbound deliveries
 * };
 * ```
 */
export type IntentState = {
  /** Host-only: registered intent kinds keyed by `name`. Filled by `register()`, read on every inbound frame. Starts empty. */
  registry: Map<string, IntentRegistration>;
  /** Host-only: highest applied `cSeq` per controller `PeerId` — the idempotence high-water mark (D4). Starts empty. */
  lastApplied: Map<PeerId, number>;
  /** Controller-only: the next `cSeq` to stamp on an outbound `IntentFrame`; monotonic, increments per `intent()`. Starts `0`. */
  nextCSeq: number;
  /** Controller-only: whether `intent()` enqueues to `buffer` instead of sending live. Toggled by `setBuffering()` from `sessionPlugin` recovery. Starts `false`. */
  buffering: boolean;
  /** Controller-only: FIFO queue of timestamped intents accumulated while `buffering`. Capped/pruned per config; drained by `drainBuffer()`. Starts empty. */
  buffer: BufferedIntent[];
  /** Controller-only: the at-least-once delivery tracker for live sends (see {@link IntentDelivery}). Built once by `createIntentApi`; the receive path and `onStop` reach the SAME instance through here. Starts `null`. */
  delivery: IntentDelivery | null;
};

/**
 * The public API of the intent plugin. Role-agnostic surface (D5) — facades re-expose role subsets.
 * `register` / `onIntent` are host-authoritative; `intent` is controller-side; `setBuffering` /
 * `drainBuffer` / `bufferedCount` are the recovery seam shared with `sessionPlugin`.
 */
export type IntentApi = {
  /**
   * Host: declares an intent kind and its correctness-only shape-check. Idempotent per `name` —
   * re-registering replaces the prior schema (the last registration wins; no throw). Must be called
   * before the matching `onIntent`. Unregistered intent names are silently dropped on receipt (D6).
   *
   * @param name - The intent kind key (matches `IntentFrame.name`).
   * @param schema - The correctness-only field/bounds shape-check for the payload.
   * @example
   * ```ts
   * stage.register("move", {
   *   fields: { dx: { type: "number", min: -1, max: 1 }, dy: { type: "number", min: -1, max: 1 } },
   *   additionalFields: false
   * });
   * ```
   */
  register(name: string, schema: IntentSchema): void;

  /**
   * Host: subscribes the single handler for a registered intent kind. The handler runs ONLY for
   * inbound frames that (a) name a registered kind, (b) pass the schema shape-check, and (c) are not a
   * duplicate (`cSeq > lastApplied[peerId]`). Re-subscribing replaces the prior handler. Returns an
   * unsubscribe function that detaches this handler (a subsequent inbound intent for `name` then drops
   * at the no-subscriber check — registration via `register` is unaffected).
   *
   * @param name - The registered intent kind to subscribe to.
   * @param handler - Invoked with `(payload, meta)` — `meta` carries `peerId` + `cSeq`.
   * @returns An unsubscribe function that removes this handler.
   * @example
   * ```ts
   * const off = stage.onIntent("move", (payload, meta) => {
   *   world.applyMove(meta.peerId, payload);
   * });
   * off(); // later, when the round ends
   * ```
   */
  onIntent(name: string, handler: IntentHandler): () => void;

  /**
   * Controller: sends one typed intent to the host. Stamps the next `cSeq`, builds an `IntentFrame`,
   * and EITHER hands it to the at-least-once delivery tracker (live — retransmitted until the host's
   * wire-level `intent-ack` receipt or, past the bounded budget, dropped with
   * `room:intent-undeliverable`) OR — when buffering is on during a host absence — enqueues it as a
   * timestamped `BufferedIntent`. Live delivery is stop-and-wait: one unacked frame in flight, later
   * intents queue behind it in `cSeq` order (§4.3). NEVER routes through Moku `emit`. Payload is not
   * validated client-side — the host is the sole authority (D6); a malformed payload is acked on
   * receipt but dropped before dispatch.
   *
   * @param name - The intent kind to send (must match a host `register` for the host to apply it).
   * @param payload - The plain-JSON intent payload.
   * @example
   * ```ts
   * controller.intent("move", { dx: 0.5, dy: 0 });
   * ```
   */
  intent(name: string, payload: JsonValue): void;

  /**
   * Recovery seam (called by `sessionPlugin`): toggles controller buffering. When `sessionPlugin`
   * detects `room:host-reconnecting` it calls `setBuffering(true)`; on reconcile completion it calls
   * `setBuffering(false)`. While `true`, `intent()` enqueues instead of sending.
   *
   * @param on - `true` to buffer subsequent intents; `false` to resume live sends.
   */
  setBuffering(on: boolean): void;

  /**
   * Recovery seam (called by `sessionPlugin`): atomically returns the buffered, pruned, `ts`-ordered
   * intents AND clears the buffer, for inclusion in a single `RecoveryFlushFrame`. Applies
   * `bufferMaxAgeMs` pruning before returning so stale analog intents are not flushed.
   *
   * @returns The drained, ordered buffer (empty if nothing is queued).
   * @example
   * ```ts
   * const buffered = intent.drainBuffer();
   * wire.send(hostId, { t: "recovery-flush", buffered });
   * ```
   */
  drainBuffer(): readonly BufferedIntent[];

  /**
   * Recovery seam: the current buffered-intent count (post-prune is NOT applied here — read-only peek).
   * Used by `sessionPlugin` / consumers for reconnect UX ("12 inputs queued").
   *
   * @returns The number of intents currently in the buffer.
   */
  bufferedCount(): number;
};
