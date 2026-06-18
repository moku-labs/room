/**
 * @file stage — delegating host API factory.
 * @see README.md
 *
 * The facade adds no logic, no validation, and no state of its own (D5): every `StageApi` method
 * is a single, unwrapped delegation to one of the three resolved engine APIs (session / intent /
 * sync). The factory takes those RESOLVED engine APIs directly (the `index.ts` wiring harness
 * resolves them inline via `ctx.require(...)`) — transportPlugin is intentionally NOT a parameter
 * here because transport is a visibility-only dependency (listed in `index.ts`'s `depends` array
 * solely so `transport`'s `room:network-warning` is mergeable for WARN-2 re-declaration +
 * forwarding). The facade calls no transport method.
 */
import type { IntentApi } from "../intent/types";
import type { SessionApi } from "../session/types";
import type { Api as SyncApi } from "../sync/types";
import type { StageApi } from "./types";

/**
 * Creates the HOST-role facade API from the three resolved engine APIs. Every method is a
 * one-line delegation: `createRoom`/`qr`/`roster` → session; `mutate`/`broadcast` → sync;
 * `onIntent` → intent (adapts engine's `(payload, meta)` callback to facade's `(payload, peerId)`
 * by unwrapping `meta.peerId`). The `transportPlugin` is intentionally absent from this factory's
 * signature — it is a visibility-only dependency wired via `depends` in `index.ts`, and the facade
 * calls no transport method (transport is reached transitively by `session`/`sync`).
 *
 * @param session - The resolved `sessionPlugin` API — `createRoom()` and `roster()` delegate here.
 * @param intent - The resolved `intentPlugin` API — `onIntent()` delegates here.
 * @param sync - The resolved `syncPlugin` API — `mutate()` and `broadcast()` delegate here.
 * @returns The {@link StageApi} host surface.
 * @example
 * ```ts
 * // index.ts wiring:
 * api: ctx =>
 *   createStageApi(
 *     ctx.require(sessionPlugin),
 *     ctx.require(intentPlugin),
 *     ctx.require(syncPlugin)
 *   );
 * ```
 */
/* eslint-disable jsdoc/require-jsdoc -- object-literal methods; domain JSDoc lives on the StageApi type in types.ts */
export function createStageApi(session: SessionApi, intent: IntentApi, sync: SyncApi): StageApi {
  return {
    createRoom: () => session.createRoom(),
    qr: () => session.qr(),
    mutate: (ns, recipe) => sync.mutate(ns, recipe),
    broadcast: () => sync.broadcast(),
    onIntent: (name, handler) =>
      intent.onIntent(name, (payload, meta) => handler(payload, meta.peerId)),
    roster: () => session.roster()
  };
}
/* eslint-enable jsdoc/require-jsdoc */
