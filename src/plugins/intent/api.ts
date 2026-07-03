/**
 * Per-app intent API factory.
 *
 * `createIntentApi` builds the ONE per-app at-least-once delivery tracker ({@link ./delivery}), stores
 * it on `state.delivery` (the receive path and `onStop` reach the SAME instance through it — D14), and
 * returns the role-agnostic consumer surface ({@link IntentApi}) over THIS app's `state` + frozen
 * `config` — NO module-level cache. It closes over the resolved transport `Wire` (the wiring harness
 * binds `ctx.require(transportPlugin).wire()`), a host-id resolver (`ctx.require(sessionPlugin)`), and
 * the narrowed `room:intent-undeliverable` emit. It does NOT register the `Wire.on` receive handler —
 * that is attached separately in `onInit` via {@link ./receive} over the same `state`. The factory takes
 * the destructured per-app pieces (not a `ctx`): `@moku-labs/web` infers `ctx` inline in `index.ts`.
 *
 * @file
 * @see README.md
 */
import type { IntentFrame, PeerId, Wire } from "../transport/protocol";
import { createIntentDelivery } from "./delivery";
import type { IntentApi, IntentConfig, IntentHandler, IntentState } from "./types";

/**
 * No-op handler used as a placeholder when a schema is registered before an `onIntent` subscriber.
 *
 * @example
 * ```ts
 * registry.set(name, { schema, handler: NOOP_HANDLER }); // until onIntent supplies the real handler
 * ```
 */
const NOOP_HANDLER: IntentHandler = () => {};

/**
 * The narrowed `emit` for the single event this plugin owns (`room:intent-undeliverable`, contracts
 * section 3.1). Bound inline in `index.ts` as `payload => ctx.emit("room:intent-undeliverable",
 * payload)`, so no domain module imports the framework `EmitFunction` (conventions section 3).
 */
type UndeliverableEmit = (payload: { name: string; cSeq: number }) => void;

/**
 * Enqueues one timestamped intent into the §5 reconnect buffer: prunes entries older than
 * `bufferMaxAgeMs`, FIFO-drops the oldest at `bufferCap`, then appends. The single enqueue path shared
 * by a buffered `intent()` call and by `setBuffering(true)`'s retirement of the live delivery window.
 *
 * @param state - The per-app intent state whose `buffer` receives the entry.
 * @param cfg - The frozen intent config (`bufferCap` + `bufferMaxAgeMs`).
 * @param frame - The fully-formed, `cSeq`-stamped frame to buffer.
 * @param now - The capture timestamp (epoch ms).
 * @example
 * ```ts
 * enqueueBuffered(state, cfg, frame, Date.now());
 * ```
 */
function enqueueBuffered(
  state: IntentState,
  cfg: Readonly<IntentConfig>,
  frame: IntentFrame,
  now: number
): void {
  // Age-prune before enqueue (avoid accumulating long-dead entries)
  const cutoff = now - cfg.bufferMaxAgeMs;
  state.buffer = state.buffer.filter(entry => entry.ts >= cutoff);
  // FIFO-drop oldest when at or over cap
  while (state.buffer.length >= cfg.bufferCap) {
    state.buffer.shift();
  }
  state.buffer.push({ intent: frame, ts: now });
}

/**
 * Builds the per-app {@link IntentApi} from this app's `state`, frozen `config`, the resolved transport
 * `wire`, a `getHostId` resolver, and the narrowed `room:intent-undeliverable` emit. Runs in the `api`
 * lifecycle phase (before `onInit`). Constructs the ONE per-app at-least-once delivery tracker and
 * stores it on `state.delivery` — mandatory for correctness: the API's live sends and the receive
 * path's inbound `intent-ack` receipts MUST hit the SAME tracker. The returned surface holds closures
 * over `state` (registry, `lastApplied`, `nextCSeq`, buffer) and the bound transport/session deps; it
 * is the only consumer-visible handle to the plugin and is never cached at module scope. `register` /
 * `onIntent` are host-authoritative; `intent` hands a controller frame to the delivery tracker (live)
 * or buffers it; `setBuffering` / `drainBuffer` / `bufferedCount` are the recovery seam `sessionPlugin`
 * drives — buffering ON retires the live window into the reconnect buffer (the §5 recovery contract
 * subsumes the §4.3 retransmit contract during a known host absence).
 *
 * @param state - The per-app intent state (registry, `lastApplied`, `nextCSeq`, buffering flag, buffer).
 * @param cfg - The frozen per-app intent config (buffer window + retransmit budget).
 * @param wire - The resolved transport `Wire` used to send a live `IntentFrame` to the host.
 * @param getHostId - Resolver for the single host `PeerId` (`sessionPlugin`) — the `wire.send` target.
 * @param emitUndeliverable - Narrowed emit for the terminal `room:intent-undeliverable` event.
 * @returns The complete role-agnostic {@link IntentApi} for this app instance.
 * @example
 * ```ts
 * const api = createIntentApi(
 *   ctx.state,
 *   ctx.config,
 *   ctx.require(transportPlugin).wire(),
 *   () => ctx.require(sessionPlugin).hostId(),
 *   payload => ctx.emit("room:intent-undeliverable", payload)
 * );
 * api.register("move", moveSchema);
 * api.onIntent("move", (payload, meta) => world.applyMove(meta.peerId, payload));
 * ```
 */
/* eslint-disable jsdoc/require-jsdoc -- object-literal method implementations; public contracts documented on IntentApi type in types.ts */
export function createIntentApi(
  state: IntentState,
  cfg: Readonly<IntentConfig>,
  wire: Wire,
  getHostId: () => PeerId,
  emitUndeliverable: UndeliverableEmit
): IntentApi {
  // Build the ONE per-app delivery tracker and stash it on state.delivery so the receive path
  // (inbound intent-ack receipts) and onStop (timer teardown) reach the SAME instance (D14).
  const delivery = createIntentDelivery(cfg, wire, getHostId, emitUndeliverable);
  state.delivery = delivery;

  return {
    register(name, schema) {
      // Idempotent per name — last registration wins for schema; preserve existing handler
      const existing = state.registry.get(name);
      state.registry.set(name, {
        schema,
        handler: existing?.handler ?? NOOP_HANDLER
      });
    },

    onIntent(name, handler) {
      const existing = state.registry.get(name);
      if (existing) {
        state.registry.set(name, { schema: existing.schema, handler });
      }
      return () => {
        const reg = state.registry.get(name);
        if (reg && reg.handler === handler) {
          // Detach by replacing handler with a no-op (registration itself remains)
          state.registry.set(name, { schema: reg.schema, handler: NOOP_HANDLER });
        }
      };
    },

    intent(name, payload) {
      const cSeq = state.nextCSeq;
      state.nextCSeq += 1;

      const frame: IntentFrame = { t: "intent", name, payload, cSeq };

      if (state.buffering) {
        enqueueBuffered(state, cfg, frame, Date.now());
      } else {
        delivery.send(frame);
      }
    },

    setBuffering(on) {
      // Buffering turns ON (known host absence): retire the live delivery window — the in-flight
      // unacked frame plus everything queued behind it — into the reconnect buffer in cSeq order, so
      // the §5 recovery flush owns the unacked tail instead of retransmits burning into a dead wire.
      if (on && !state.buffering) {
        const now = Date.now();
        for (const frame of delivery.retire()) {
          enqueueBuffered(state, cfg, frame, now);
        }
      }
      state.buffering = on;
    },

    drainBuffer() {
      const now = Date.now();
      const cutoff = now - cfg.bufferMaxAgeMs;
      // Prune stale entries before returning; clear the buffer atomically
      const result = state.buffer
        .filter(entry => entry.ts >= cutoff)
        .toSorted((a, b) => a.ts - b.ts);
      state.buffer = [];
      return result;
    },

    bufferedCount() {
      return state.buffer.length;
    }
  };
}
/* eslint-enable jsdoc/require-jsdoc */
