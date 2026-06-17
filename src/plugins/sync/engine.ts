/**
 * @file The per-app `SyncEngine` implementation for `syncPlugin`.
 * @see README.md
 *
 * Built EXACTLY ONCE per app in `index.ts`'s `api` over THIS app's `ctx.state`/`ctx.config`/`Wire`/
 * `SessionApi`/`emit`, then shared via `ctx.state.engine`. Owns the slice registry, the per-namespace
 * dirty-flag, the 20-30 Hz throttle broadcast loop (timer id stored in `state.throttleHandle`), the
 * read-only replica apply path with `sSeq` gap detection, the per-namespace `subscribe` callback `Map`
 * (a closure-scope `Map` — kept OUT of `State` so `State.snapshot` stays plain-JSON), and the single
 * `room:sync-ready` emit. Pure codec work delegates to `codec.ts`. All wire I/O rides the injected `Wire`
 * (contracts section 2) — NEVER Moku `emit` (only `room:sync-ready` rides `emit`). Shared contract types
 * are imported from `../../contracts` (D16); `SessionApi` from the owning `session` plugin.
 */
import type { Wire } from "../../contracts";
import type { SessionApi } from "../session/types";
import type { Config, State, SyncEngine } from "./types";

/**
 * The narrowed `emit` the engine needs — a zero-arg closure that signals the single event this plugin
 * owns (`room:sync-ready`, contracts section 3.1). The wiring harness binds it inline in `index.ts` as
 * `() => ctx.emit("room:sync-ready", {})`, so the engine never imports the framework `EmitFunction` (the
 * empty `{}` payload is supplied at the bind site, conventions section 3).
 */
type SyncReadyEmit = () => void;

/**
 * Builds the ONE per-app `SyncEngine` over this app's mutable state, config, transport `Wire`, session
 * roster, and a narrowed `emit`. A LOCAL factory bound to the passed `ctx` members — NOT a module-level
 * singleton — so each composed app (the `inMemory` stage + N controllers) gets its own engine and its own
 * `subscribe` callback `Map`. Building once and sharing via `ctx.state.engine` is mandatory for
 * correctness: consumer subscriptions and inbound-frame application MUST hit the SAME engine/`Map`.
 *
 * @param state - This app's mutable `syncPlugin` state (`ctx.state`).
 * @param config - This app's frozen `syncPlugin` config (`ctx.config`).
 * @param wire - The transport `Wire` obtained via `ctx.require(transportPlugin).wire()` (contracts section 2).
 * @param session - The `SessionApi` from `ctx.require(sessionPlugin)` (roster/`PeerId` access).
 * @param emit - The narrowed zero-arg `emit` closure that signals `room:sync-ready` (bound in `index.ts`).
 * @throws {Error} Always — skeleton stub.
 * @example
 * ```ts
 * const engine = createSyncEngine(state, config, wire, session, () => emit("room:sync-ready", {}));
 * state.engine = engine;
 * ```
 */
export function createSyncEngine(
  state: State,
  config: Readonly<Config>,
  wire: Wire,
  session: SessionApi,
  emit: SyncReadyEmit
): SyncEngine {
  throw new Error("not implemented");
}
