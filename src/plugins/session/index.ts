/**
 * session — Complex tier.
 *
 * Room lifecycle (createRoom/joinRoom/leave/rejoin), presence/roster (stable PeerId + phone-persisted
 * reconnectToken, 8-cap, star-topology enforcement), and the full CLIENT-SIDE host-reload recovery state
 * machine (D11): hostToken mint/verify peer-side, debounced IndexedDB + synchronous localStorage on
 * visibilitychange, rejoin-same-room, intent-buffer flush + reconcile, ~10s timeout, iOS "rescan QR"
 * degrade. Emits room:peer-joined, room:peer-left, room:host-reconnecting. Depends on transport.
 *
 * Each extracted module (`api`/`handlers`/`lifecycle/*`/`recovery/*`) receives the destructured
 * `SessionDeps` bundle `makeSessionDeps` builds from the inferred `ctx` — so no domain module imports the
 * web-unavailable `PluginContext` (D1) and none closes over a module-level singleton (D14).
 *
 * @see README.md
 */
import { createPlugin } from "@moku-labs/web/browser";
import type { RoomEvents } from "../../contracts";
import { transportPlugin } from "../transport";
import { createSessionApi, makeSessionDeps } from "./api";
import { sessionConfig } from "./config";
import { teardownSession } from "./recovery/persistence";
import { detectHostReload, registerTransportBindings } from "./recovery/reentry";
import { createSessionState } from "./state";
import type { SessionState } from "./types";

/**
 * Per-app teardown registry (D14/D15). Maps each app instance's FROZEN global config object (`ctx.global`)
 * to its `SessionState`, so the `{ global }`-only `onStop` can reach the live recovery handles WITHOUT
 * `ctx.state`. `onStart` sets the entry; `onStop` reads + deletes it. Keyed by `object` identity (D15) —
 * per-instance-correct across the multiple app instances Room composes in one process, and auto-GC. This
 * is the ONLY module-level value — there is NO module-level `let` holding an instance or handle.
 */
const teardownRegistry = new WeakMap<object, SessionState>();

/* eslint-disable jsdoc/require-jsdoc -- structural wiring callbacks (events/api/onInit/onStart/onStop); domain JSDoc lives in the extracted state/api/handlers/lifecycle/recovery modules */
/**
 * `sessionPlugin` — the room-lifecycle and presence authority of Room (Complex tier). Imported from
 * `@moku-labs/web` (D1). Wiring-only harness; all logic lives in the extracted modules, which receive the
 * `SessionDeps` bundle. `onInit` wires transport bindings + detects host reload; `onStart` registers this
 * app's state for teardown (no network resource opened); `onStop` flushes + disposes recovery handles via
 * the `teardownRegistry` keyed by `ctx.global`.
 *
 * @see README.md
 */
export const sessionPlugin = createPlugin("session", {
  depends: [transportPlugin],
  config: sessionConfig,
  events: register =>
    register.map<
      Pick<RoomEvents, "room:peer-joined" | "room:peer-left" | "room:host-reconnecting">
    >({
      "room:peer-joined":
        "A controller's DataChannel reached connected and was added to the roster.",
      "room:peer-left":
        "A controller left or was declared dead by the heartbeat and removed from the roster.",
      "room:host-reconnecting": "The host tab reloaded; client-side recovery is in flight."
    }),
  createState: createSessionState,
  api: ctx => createSessionApi(makeSessionDeps(ctx)),
  // @no-resource-check — onStart/onStop manage recovery timers + the debounced persistence driver
  // (IndexedDB + visibilitychange localStorage listener), torn down via the D14 per-instance registry.
  onInit: ctx => {
    const deps = makeSessionDeps(ctx);
    registerTransportBindings(deps);
    detectHostReload(deps);
  },
  onStart: ctx => {
    teardownRegistry.set(ctx.global, ctx.state);
  },
  onStop: ctx => {
    const s = teardownRegistry.get(ctx.global);
    if (s) {
      teardownSession(s);
      teardownRegistry.delete(ctx.global);
    }
  }
});
/* eslint-enable jsdoc/require-jsdoc */
