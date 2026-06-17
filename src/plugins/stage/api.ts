/**
 * @file stage — delegating host API factory.
 * @see README.md
 *
 * The facade adds no logic, no validation, and no state of its own (D5): every `StageApi` method is a
 * single, unwrapped delegation to one of the four resolved engine APIs. The factory takes those four
 * RESOLVED engine APIs directly (the `index.ts` wiring harness resolves them inline via
 * `ctx.require(...)`) — NEVER a `ctx`/`PluginContext` value (`@moku-labs/web` does not export it, D1).
 * `transport` is passed for shape/visibility symmetry with the `depends` array but no method is called on
 * it (it is a visibility-only dependency — see the Dependencies note in README.md).
 */
import type { IntentApi } from "../intent/types";
import type { SessionApi } from "../session/types";
import type { Api as SyncApi } from "../sync/types";
import type { TransportApi } from "../transport/types";
import type { StageApi } from "./types";

/**
 * Creates the HOST-role facade API from the four resolved engine APIs. Every method delegates to one of
 * `session` / `sync` / `intent`; the `onIntent` delegation adapts the engine's `(payload, meta)` callback
 * to this facade's `(payload, peerId)` surface by unwrapping `meta.peerId`. `transport` is accepted for
 * symmetry with `index.ts`'s `depends` array but is never called (visibility-only dependency).
 *
 * @param transport - The resolved `transportPlugin` API (visibility-only; no method is invoked).
 * @param session - The resolved `sessionPlugin` API — `createRoom()` / `roster()` delegate here.
 * @param intent - The resolved `intentPlugin` API — `onIntent()` delegates here.
 * @param sync - The resolved `syncPlugin` API — `mutate()` / `broadcast()` delegate here.
 * @throws {Error} Always — skeleton stub; replace with the delegating returns during build.
 * @example
 * ```ts
 * // index.ts wiring:
 * api: ctx =>
 *   createStageApi(
 *     ctx.require(transportPlugin),
 *     ctx.require(sessionPlugin),
 *     ctx.require(intentPlugin),
 *     ctx.require(syncPlugin)
 *   );
 * ```
 */
export function createStageApi(
  transport: TransportApi,
  session: SessionApi,
  intent: IntentApi,
  sync: SyncApi
): StageApi {
  throw new Error("not implemented");
}
