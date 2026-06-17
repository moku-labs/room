/**
 * @file `createSessionApi` + `makeSessionDeps` — the API factory plus the `ctx`->`SessionDeps` builder.
 * `createSessionApi` is thin orchestration only: each method delegates to `lifecycle/*` (code/qr/roster)
 * and `recovery/*` (persistence/hosttoken/reentry/buffer/timeout) domain functions and pushes wire frames
 * through the transport API (`deps.requireTransport()`). No wire/DataChannel traffic flows through `emit` —
 * only the coarse `room:*` events do.
 * @see README.md
 *
 * Both functions take the destructured per-app pieces (never a `ctx` value/type): `@moku-labs/web` infers
 * `ctx` inline in `index.ts`, and `makeSessionDeps` narrows that inferred `ctx` (via the structural
 * {@link SessionContextShape}, NOT the web-unavailable `PluginContext`) into the {@link SessionDeps} bundle the
 * extracted modules consume. Keeping the builder HERE lets the `index.ts` harness stay a ≤30-line wiring.
 */

import { transportPlugin } from "../transport";
import type { SessionApi, SessionContextShape, SessionDeps } from "./types";

/**
 * Narrows the inferred plugin `ctx` into the destructured {@link SessionDeps} bundle (D14): the per-app
 * `state` + frozen `config`, the three narrowed `room:*` `emit` closures, and a `requireTransport` closure
 * over `ctx.require(transportPlugin)`. Called inline by the `index.ts` wiring harness for both `api` and
 * `onInit`, so every extracted module stays `ctx`-free (and never imports the web-unavailable
 * `PluginContext`).
 *
 * @param ctx - The inferred plugin context, structurally narrowed to {@link SessionContextShape}.
 * @returns The destructured `SessionDeps` bundle for `createSessionApi`/`onInit`.
 * @example
 * ```ts
 * api: (ctx) => createSessionApi(makeSessionDeps(ctx));
 * ```
 */
/* eslint-disable jsdoc/require-jsdoc -- structural wiring closures (the narrowed room:* emit + requireTransport); domain JSDoc lives in the extracted modules */
export function makeSessionDeps(ctx: SessionContextShape): SessionDeps {
  return {
    state: ctx.state,
    config: ctx.config,
    emit: {
      peerJoined: payload => ctx.emit("room:peer-joined", payload),
      peerLeft: payload => ctx.emit("room:peer-left", payload),
      hostReconnecting: payload => ctx.emit("room:host-reconnecting", payload)
    },
    requireTransport: () => ctx.require(transportPlugin)
  };
}
/* eslint-enable jsdoc/require-jsdoc */

/**
 * Builds the public `SessionApi` bound to THIS app's destructured `deps` (D14 — closes over the per-app
 * `state`/`requireTransport`/`emit`, never a module-level singleton). Star-topology and the
 * `maxControllers` cap are enforced inside the returned methods (§6).
 *
 * @param deps - This app's destructured per-instance pieces (`state`, `config`, `emit`, `requireTransport`).
 * @throws {Error} Always — skeleton stub.
 * @example
 * ```ts
 * api: (ctx) => createSessionApi(makeSessionDeps(ctx));
 * ```
 */
export function createSessionApi(deps: SessionDeps): SessionApi {
  throw new Error("not implemented");
}
