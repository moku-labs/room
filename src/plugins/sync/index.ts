import { createPlugin } from "@moku-labs/web";
import type { RoomEvents } from "../../contracts";
import { sessionPlugin } from "../session";
import { transportPlugin } from "../transport";
import { createSyncApi } from "./api";
import { DEFAULT_SYNC_CONFIG } from "./config";
import { createSyncState } from "./state";
import type { State } from "./types";

// D14 per-instance teardown registry — module-level `const` (NOT a `let` holding an instance). Maps each
// app's own frozen `ctx.global` config to that app's mutable `State` (and through it the shared
// `state.engine` + `state.throttleHandle`), so `onStop` — which gets `{ global }` only (no `require`, no
// `ctx.state`) — can reach EXACTLY this app's engine to stop the 20-30 Hz throttle loop. Room composes
// multiple app instances in one process, so a singleton `let` would be overwritten by the next createApp
// and `app1.stop()` would clear `app2`'s timer. Key type `object` (Room declares no Config of its own,
// D1; `ctx.global` is the host framework's frozen global). Auto-GC.
const teardownRegistry = new WeakMap<object, State>();

/* eslint-disable jsdoc/require-jsdoc -- structural wiring callbacks (api/onInit/events/hooks/onStart/onStop); domain JSDoc lives in the extracted state/api/engine/codec modules */
/**
 * sync — Complex tier plugin.
 *
 * Role-agnostic authoritative sync engine (D4): host registers namespaced typed slices and broadcasts
 * sequence-numbered op-list deltas at 20-30 Hz; controllers hold a read-only replica and apply
 * snapshot/delta frames in order. Owns the snapshot-persistence seam that feeds sessionPlugin's
 * client-side host-reload recovery (D11). Emits `room:sync-ready`. All wire I/O rides transport
 * (contracts section 2) — never Moku emit (spec/07 section 3; spec/11 section 2.7). No explicit generics:
 * Config/State/Api/Events all infer from this spec object (conventions section 4; spec/14 section 1).
 *
 * @see README.md
 */
export const syncPlugin = createPlugin("sync", {
  depends: [transportPlugin, sessionPlugin],
  config: DEFAULT_SYNC_CONFIG,
  createState: createSyncState,
  events: register =>
    register.map<Pick<RoomEvents, "room:sync-ready">>({
      "room:sync-ready": "First authoritative snapshot applied; the synced replica is now readable."
    }),
  api: ctx =>
    createSyncApi(
      ctx.state,
      ctx.config,
      ctx.require(transportPlugin).wire(),
      ctx.require(sessionPlugin),
      () => ctx.emit("room:sync-ready", {})
    ),
  onInit: ctx => ctx.state.engine?.init(),
  hooks: ctx => ({
    "room:peer-joined": payload => ctx.state.engine?.sendBaselineSnapshot(payload.peerId)
  }),
  // @no-resource-check — onStart/onStop start + stop the 20-30 Hz throttle broadcast loop, torn down via
  // the D14 per-instance registry (onStop gets `{ global }` only — no `ctx.state`). contracts section 4.3.
  onStart: ctx => {
    ctx.state.engine?.startBroadcast();
    teardownRegistry.set(ctx.global, ctx.state);
  },
  onStop: ctx => {
    teardownRegistry.get(ctx.global)?.engine?.stopBroadcast();
    teardownRegistry.delete(ctx.global);
  }
});
/* eslint-enable jsdoc/require-jsdoc */
