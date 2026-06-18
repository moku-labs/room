/**
 * @file The controller facade delegation factory. Builds `ControllerApi` by delegating every method to
 * one of the three resolved Room engine APIs (`session` / `intent` / `sync`). Holds no Moku state —
 * the wake-lock sentinel is a transient browser handle kept in a closure (never synced, never JSON,
 * never crosses the wire). No `room:*` forwarding hooks are installed (D19 — Moku's global event bus
 * delivers each engine's emit to a `depends:[controllerPlugin]` consumer directly; a re-emitting hook
 * would recurse infinitely). The `index.ts` `events` block re-declares the five keys for compile-time
 * type visibility only (WARN-2). The factory takes the three already-resolved engine APIs directly (NOT
 * a `ctx`): `@moku-labs/web` infers `ctx` inline in `index.ts`, which calls `ctx.require(...)` for each
 * engine and passes the resolved surfaces here. `transportPlugin` is a visibility-only dependency
 * wired in `index.ts`'s `depends` array; no transport method is ever called from the facade.
 * @see README.md
 */
import type { IntentApi } from "../intent/types";
import type { SessionApi } from "../session/types";
import type { Api as SyncApi } from "../sync/types";
import type { ControllerApi } from "./types";

/**
 * Requests the iOS Screen Wake Lock (`navigator.wakeLock.request("screen")`, Safari 16.4+) so the
 * screen does not dim/lock and SUSPEND the controller's DataChannel mid-session (D11 — the wake lock
 * is the mitigation; there is no code-only fix for the suspend). Feature-detected: when
 * `navigator.wakeLock` is absent (older iOS / non-secure context / Node test environment) or the
 * request is denied (`NotAllowedError`), it resolves `null` rather than throwing. The returned
 * {@link WakeLockSentinel} is a transient browser handle — held only in a closure by
 * {@link createControllerApi}, never Moku state, never serialized, never sent over the §2 wire.
 * The one browser resource the facade touches directly (every other concern delegates to an engine).
 * Exported so the wake-lock concern is independently testable before `requestWakeLock`/
 * `releaseWakeLock` bodies are invoked through the full API.
 *
 * @returns A promise resolving the `WakeLockSentinel` if acquired, or `null` if the platform does
 *   not support wake locks or the request is denied (never rejects — D11 graceful degrade).
 * @example
 * ```ts
 * const sentinel = await requestScreenWakeLock(); // WakeLockSentinel | null
 * if (sentinel) sentinel.addEventListener("release", () => { ... });
 * ```
 */
export async function requestScreenWakeLock(): Promise<WakeLockSentinel | null> {
  if (typeof navigator === "undefined" || !("wakeLock" in navigator)) return null;
  try {
    return await navigator.wakeLock.request("screen");
  } catch {
    return null; // NotAllowedError etc. — never throws (D11 graceful degrade)
  }
}

/**
 * Builds the controller facade API by delegating to the three resolved engine APIs. `joinRoom` maps
 * `session`'s discriminated `JoinResult` to a resolve/throw contract; `read`/`on` pass through to
 * `sync`; `intent` passes through to `intent`; `requestWakeLock`/`releaseWakeLock` drive the iOS
 * Screen Wake Lock via {@link requestScreenWakeLock}, holding the `WakeLockSentinel | null` in a
 * closure variable (a transient browser handle — never Moku state, never synced). Every delegating
 * method is a typed pass-through whose types are pinned to the engine method it forwards to.
 * `transportPlugin` is a visibility-only dependency (its `room:network-warning` is re-declared in
 * `index.ts` for type visibility; D19 — no forwarding hooks); no transport method is called here.
 *
 * @param session - The resolved `sessionPlugin` API (`joinRoom` delegates here).
 * @param intent - The resolved `intentPlugin` API (`intent` delegates here).
 * @param sync - The resolved `syncPlugin` API (`read`/`on` delegate here).
 * @returns The {@link ControllerApi} surface.
 * @example
 * ```ts
 * // index.ts wiring:
 * api: ctx => createControllerApi(
 *   ctx.require(sessionPlugin),
 *   ctx.require(intentPlugin),
 *   ctx.require(syncPlugin)
 * )
 * ```
 */
/* eslint-disable jsdoc/require-jsdoc -- object-literal method implementations; public contracts documented on ControllerApi type in types.ts */
export function createControllerApi(
  session: SessionApi,
  intent: IntentApi,
  sync: SyncApi
): ControllerApi {
  // Transient browser handle — NOT Moku state, NOT JSON, never crosses the wire (spec/11 §1.7).
  let wakeSentinel: WakeLockSentinel | null = null;

  return {
    joinRoom: async code => {
      // sessionPlugin sets the passive (controller-role) flag internally (§1.1) — no caller arg here.
      // Map the discriminated JoinResult to this contract: throw the reason rather than silently drop it.
      const r = await session.joinRoom(code);
      if (!r.ok) throw new Error(r.reason); // "full" | "not-found" | "unreachable" (§6.2)
    },
    read: ns => sync.read(ns),
    on: (ns, cb) => sync.subscribe(ns, cb),
    intent: (name, payload) => intent.intent(name, payload),
    requestWakeLock: async () => {
      if (wakeSentinel) return true; // idempotent — sentinel already held
      const s = await requestScreenWakeLock();
      if (!s) return false;
      wakeSentinel = s;
      wakeSentinel.addEventListener("release", () => {
        wakeSentinel = null;
      });
      return true;
    },
    releaseWakeLock: async () => {
      await wakeSentinel?.release();
      wakeSentinel = null;
    }
  };
}
/* eslint-enable jsdoc/require-jsdoc */
