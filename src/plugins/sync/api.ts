/**
 * @file `createSyncApi` — the public `Api` factory for `syncPlugin` (builds the engine, then delegates).
 * @see README.md
 *
 * Built once per app from the destructured per-app pieces the wiring harness passes (NOT a `ctx`):
 * `@moku-labs/web` infers `ctx` inline in `index.ts`. `createSyncApi` constructs the ONE per-app
 * `SyncEngine` (the shared instance every lifecycle method reaches via `ctx.state.engine`), stores it on
 * `state.engine`, and returns the public, role-agnostic `Api` as a THIN delegation over it (spec/15
 * section 5 — `index.ts` wires, domain files implement). Every API method forwards to the matching engine
 * method (registry/dirty-flag/throttle for host writes; replica apply/subscription for controller reads;
 * codec-backed snapshot serialize for the recovery seam). No logic lives here beyond engine construction
 * + delegation — the engine owns the state, the subscription `Map`, and the codec calls. Shared contract
 * types are imported from `../../contracts` (D16); `SessionApi` from the owning `session` plugin.
 */
import type { Wire } from "../../contracts";
import type { SessionApi } from "../session/types";
import type { Api, Config, State } from "./types";

/**
 * The narrowed zero-arg `emit` closure that signals the single event this plugin owns (`room:sync-ready`,
 * contracts section 3.1). Bound inline in `index.ts` as `() => ctx.emit("room:sync-ready", {})`, so no
 * module imports the framework `EmitFunction` (conventions section 3).
 */
type SyncReadyEmit = () => void;

/**
 * Builds the ONE per-app `SyncEngine`, stores it on `state.engine`, and wraps it in the public,
 * role-agnostic `Api` surface (D4/D5). The facades (`stagePlugin`/`controllerPlugin`) re-expose
 * role-appropriate subsets of the returned `Api`. Building once and sharing via `state.engine` is
 * mandatory for correctness: consumer subscriptions and inbound-frame application MUST hit the SAME
 * engine/`subscribe` `Map`. Called from `index.ts`'s `api` with the per-app pieces.
 *
 * @param state - This app's mutable `syncPlugin` state (`ctx.state`); receives the built engine.
 * @param config - This app's frozen `syncPlugin` config (`ctx.config`).
 * @param wire - The transport `Wire` from `ctx.require(transportPlugin).wire()` (contracts section 2).
 * @param session - The `SessionApi` from `ctx.require(sessionPlugin)` (roster/`PeerId` access).
 * @param emit - The narrowed zero-arg `emit` closure that signals `room:sync-ready` (bound in `index.ts`).
 * @throws {Error} Always — skeleton stub.
 * @example
 * ```ts
 * const api = createSyncApi(
 *   ctx.state,
 *   ctx.config,
 *   ctx.require(transportPlugin).wire(),
 *   ctx.require(sessionPlugin),
 *   () => ctx.emit("room:sync-ready", {})
 * );
 * ```
 */
export function createSyncApi(
  state: State,
  config: Readonly<Config>,
  wire: Wire,
  session: SessionApi,
  emit: SyncReadyEmit
): Api {
  throw new Error("not implemented");
}
