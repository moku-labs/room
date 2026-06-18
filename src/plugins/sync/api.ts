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
import { createSyncEngine } from "./engine";
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
 * @returns The public role-agnostic `Api` surface backed by the one per-app engine.
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
  // Build the ONE per-app engine and stash it on state.engine so onInit/hooks/onStart/onStop
  // can reach the SAME instance (mandatory for subscribe Map correctness — D14).
  const engine = createSyncEngine(state, config, wire, session, emit);
  state.engine = engine;

  // Return the public Api as a thin delegation over the engine. No logic here — the engine owns the
  // state, subscription Map, and codec calls. Each method's contract is documented on the `Api` type.
  /* eslint-disable jsdoc/require-jsdoc -- thin delegation; each method's contract is documented on the Api type in types.ts */
  return {
    registerSlice: (ns, initial) => engine.registerSlice(ns, initial),
    mutate: (ns, recipe) => engine.mutate(ns, recipe),
    broadcast: peerId => engine.broadcast(peerId),
    onResyncRequest: handler => engine.onResyncRequest(handler),
    read: ns => engine.read(ns),
    subscribe: (ns, cb) => engine.subscribe(ns, cb),
    applyFrame: frame => engine.applyFrame(frame),
    isReady: () => engine.isReady(),
    exportSnapshot: () => engine.exportSnapshot(),
    importSnapshot: (snapshot, sSeq) => engine.importSnapshot(snapshot, sSeq),
    startBroadcast: () => engine.startBroadcast(),
    stopBroadcast: () => engine.stopBroadcast()
  };
  /* eslint-enable jsdoc/require-jsdoc */
}
