/**
 * Per-app intent API factory.
 *
 * `createIntentApi` builds the role-agnostic consumer surface ({@link IntentApi}) over THIS app's
 * `state` + frozen `config` and returns it directly — NO module-level cache (D14). It closes over the
 * resolved transport `Wire` (the wiring harness binds `ctx.require(transportPlugin).wire()`) and a host-id
 * resolver (`ctx.require(sessionPlugin)`), and over the validate → de-dup → dispatch pipeline. It does
 * NOT register the `Wire.on` receive handler — that is attached separately in `onInit` via
 * {@link ./receive} over the same `state`. The factory takes the destructured per-app pieces (not a
 * `ctx`): `@moku-labs/web` infers `ctx` inline in `index.ts`.
 *
 * @file
 * @see README.md
 */
import type { IntentFrame, PeerId, Wire } from "../transport/protocol";
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
 * Builds the per-app {@link IntentApi} from this app's `state`, frozen `config`, the resolved transport
 * `wire`, and a `getHostId` resolver. Runs in the `api` lifecycle phase (before `onInit`). The returned
 * surface holds closures over `state` (registry, `lastApplied`, `nextCSeq`, buffer) and the bound
 * transport/session deps; it is the only consumer-visible handle to the plugin and is never cached at
 * module scope. `register` / `onIntent` are host-authoritative; `intent` routes a controller frame over
 * `wire.send(getHostId(), …)` (live) or buffers it; `setBuffering` / `drainBuffer` / `bufferedCount` are
 * the recovery seam `sessionPlugin` drives.
 *
 * @param state - The per-app intent state (registry, `lastApplied`, `nextCSeq`, buffering flag, buffer).
 * @param cfg - The frozen per-app intent config (controller-side `bufferCap` + `bufferMaxAgeMs`).
 * @param wire - The resolved transport `Wire` used to send a live `IntentFrame` to the host.
 * @param getHostId - Resolver for the single host `PeerId` (`sessionPlugin`) — the `wire.send` target.
 * @returns The complete role-agnostic {@link IntentApi} for this app instance.
 * @example
 * ```ts
 * const api = createIntentApi(ctx.state, ctx.config, ctx.require(transportPlugin).wire(), () =>
 *   ctx.require(sessionPlugin).hostId()
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
  getHostId: () => PeerId
): IntentApi {
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
        const now = Date.now();
        // Age-prune before enqueue (avoid accumulating long-dead entries)
        const cutoff = now - cfg.bufferMaxAgeMs;
        state.buffer = state.buffer.filter(entry => entry.ts >= cutoff);
        // FIFO-drop oldest when at or over cap
        while (state.buffer.length >= cfg.bufferCap) {
          state.buffer.shift();
        }
        state.buffer.push({ intent: frame, ts: now });
      } else {
        wire.send(getHostId(), frame);
      }
    },

    setBuffering(on) {
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
