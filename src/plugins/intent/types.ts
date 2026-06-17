/**
 * Public + internal type contracts for the intent plugin.
 *
 * Carries the CONCRETE signatures from the spec: the role-agnostic {@link IntentApi}, the controller-side
 * buffer {@link IntentConfig}, the correctness-only {@link IntentSchema} / {@link IntentFieldRule} (D6),
 * and the per-app {@link IntentState}. Shared wire/roster types (`IntentFrame`, `PeerId`, `JsonValue`)
 * are imported from the central `../../contracts` module (D16) — never re-declared here.
 *
 * @file
 * @see README.md
 */
import type { IntentFrame, JsonValue, PeerId } from "../../contracts";

/**
 * Configuration for the intent plugin.
 *
 * Governs ONLY the controller-side reconnect buffer (recovery contract). There is no validation knob:
 * shape-checking is correctness-only and always on (D6 — no anti-cheat / rate-limit toggle would make
 * sense in the trusted living-room threat model). Flat config (no nesting).
 *
 * @example
 * ```ts
 * // Defaults — a 256-entry, 10-second buffer window.
 * const cfg: IntentConfig = { bufferCap: 256, bufferMaxAgeMs: 10_000 };
 * ```
 */
export type IntentConfig = {
  /**
   * Maximum number of timestamped intents the controller buffers during a host absence before the
   * OLDEST entries are discarded (FIFO drop). Bounds memory for high-frequency analog intents
   * (e.g. a tilt/joystick stream) when a host reload runs long. Lossy by design. Default `256`.
   */
  readonly bufferCap: number;
  /**
   * Maximum age, in milliseconds, a buffered intent is kept before it is pruned on the next enqueue
   * or drain. Should be `>=` the `sessionPlugin` reconnect timeout (~10 s) so the buffer never
   * out-lives the recovery window it feeds. Default `10_000`.
   */
  readonly bufferMaxAgeMs: number;
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
 *   buffer: []
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
   * and EITHER hands it to the transport `Wire.send` (live) OR — when buffering is on during a host
   * absence — enqueues it as a timestamped `BufferedIntent`. NEVER routes through Moku `emit`. Payload
   * is not validated client-side — the host is the sole authority (D6); a malformed payload is simply
   * dropped on arrival.
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
