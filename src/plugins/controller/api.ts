/**
 * @file The controller facade delegation factory. Builds `ControllerApi` by delegating every method to
 * one of the four resolved Room engine APIs (`transport` / `session` / `intent` / `sync`). Holds no Moku
 * state — the wake-lock sentinel is a transient browser handle kept in a closure (never synced, never
 * JSON, never crosses the wire). The five `room:*` forwarding hooks live in `index.ts` (a thin facade has
 * no separate `handlers.ts`). The factory takes the four already-resolved engine APIs (NOT a `ctx`):
 * `@moku-labs/web` infers `ctx` inline in `index.ts`, which calls `ctx.require(...)` for each engine and
 * passes the resolved surfaces here (so `PluginContext` is never imported — it is not exported by web, D1).
 * @see README.md
 */
import type { IntentApi } from "../intent/types";
import type { SessionApi } from "../session/types";
import type { Api as SyncApi } from "../sync/types";
import type { TransportApi } from "../transport/types";
import type { ControllerApi } from "./types";

/**
 * Requests the iOS Screen Wake Lock (`navigator.wakeLock.request("screen")`, Safari 16.4+) so the screen
 * does not dim/lock and SUSPEND the controller's DataChannel mid-session (D11 — the wake lock is the
 * mitigation; there is no code-only fix for the suspend). Feature-detected: when `navigator.wakeLock` is
 * absent (older iOS / non-secure context) or the request is denied (`NotAllowedError`), it resolves
 * `null` rather than throwing. The returned {@link WakeLockSentinel} is a transient browser handle — held
 * only in a closure by {@link createControllerApi}, never Moku state, never serialized, never sent over
 * the §2 wire. The one browser resource the facade touches directly (every other concern delegates to an
 * engine). Exported so this skeleton's wake-lock concern is referenced + testable before the
 * `requestWakeLock`/`releaseWakeLock` bodies are implemented.
 *
 * @throws {Error} Always — skeleton stub.
 * @example
 * ```ts
 * const sentinel = await requestScreenWakeLock(); // WakeLockSentinel | null
 * ```
 */
export function requestScreenWakeLock(): Promise<WakeLockSentinel | null> {
  throw new Error("not implemented");
}

/**
 * Builds the controller facade API by delegating to the four resolved engine APIs. `joinRoom` maps
 * `session`'s discriminated `JoinResult` to a resolve/throw contract; `read`/`on` pass through to `sync`;
 * `intent` passes through to `intent`; `requestWakeLock`/`releaseWakeLock` drive the iOS Screen Wake Lock
 * via {@link requestScreenWakeLock}, holding the `WakeLockSentinel | null` in a closure variable (a
 * transient browser handle — never Moku state, never synced). Every delegating method is a typed
 * pass-through whose types are pinned to the engine method it forwards to. `transport` is a
 * visibility-only dependency (its `room:network-warning` is re-declared + forwarded in `index.ts`); no
 * `transport` method is called here, so it is accepted but unused in the skeleton.
 *
 * @param transport - The resolved `transportPlugin` API (visibility-only; no method is called).
 * @param session - The resolved `sessionPlugin` API (`joinRoom` delegates here).
 * @param intent - The resolved `intentPlugin` API (`intent` delegates here).
 * @param sync - The resolved `syncPlugin` API (`read`/`on` delegate here).
 * @throws {Error} Always — skeleton stub.
 * @example
 * ```ts
 * // index.ts wiring:
 * api: ctx =>
 *   createControllerApi(
 *     ctx.require(transportPlugin),
 *     ctx.require(sessionPlugin),
 *     ctx.require(intentPlugin),
 *     ctx.require(syncPlugin)
 *   );
 * ```
 */
export function createControllerApi(
  transport: TransportApi,
  session: SessionApi,
  intent: IntentApi,
  sync: SyncApi
): ControllerApi {
  throw new Error("not implemented");
}
