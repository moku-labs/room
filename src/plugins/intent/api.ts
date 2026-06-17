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
import type { PeerId, Wire } from "../../contracts";
import type { IntentApi, IntentConfig, IntentState } from "./types";

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
 * @throws {Error} Always — skeleton stub.
 * @example
 * ```ts
 * const api = createIntentApi(ctx.state, ctx.config, ctx.require(transportPlugin).wire(), () =>
 *   ctx.require(sessionPlugin).hostId()
 * );
 * api.register("move", moveSchema);
 * api.onIntent("move", (payload, meta) => world.applyMove(meta.peerId, payload));
 * ```
 */
export function createIntentApi(
  state: IntentState,
  cfg: Readonly<IntentConfig>,
  wire: Wire,
  getHostId: () => PeerId
): IntentApi {
  throw new Error("not implemented");
}
