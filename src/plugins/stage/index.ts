import { createPlugin } from "@moku-labs/web";
import type { RoomEvents } from "../../contracts";
import { intentPlugin } from "../intent";
import { sessionPlugin } from "../session";
import { syncPlugin } from "../sync";
import { transportPlugin } from "../transport";
import { createStageApi } from "./api";

/* eslint-disable jsdoc/require-jsdoc -- structural wiring callbacks (events/hooks/api); domain JSDoc lives in the extracted api/types modules */
/**
 * Stage plugin — Standard tier (HOST-role facade).
 *
 * A thin host surface over Room's four engines (transport, session, intent, sync): every API method
 * delegates via `ctx.require(...)`, the facade owns no state and runs no resource. Re-declares + forwards
 * all five `room:*` lifecycle events (contracts §3) so a game plugin with `depends: [stagePlugin]` gets
 * the complete, typed hook surface in one edge (WARN-2 — event visibility is not transitive: spec/07 §5,
 * spec/14 §7). No `onStart`/`onStop`: the facade manages no resource; the engines own all lifecycle
 * (spec/06). Shipped pre-composed as `roomPlugins.stage = [transport, session, intent, sync, stage]`.
 *
 * @see README.md
 */
export const stagePlugin = createPlugin("stage", {
  depends: [transportPlugin, sessionPlugin, intentPlugin, syncPlugin],
  events: register =>
    register.map<RoomEvents>({
      "room:peer-joined":
        "A controller's DataChannel reached connected and joined the roster (contracts §3).",
      "room:peer-left":
        "A controller left or was declared dead by the heartbeat and left the roster (contracts §3).",
      "room:host-reconnecting":
        "Host tab reloaded; client-side recovery is in flight (contracts §5).",
      "room:sync-ready":
        "First full snapshot applied; the synced replica is now readable (contracts §4).",
      "room:network-warning":
        "A connectivity hard-failure surfaced for failure UX (contracts §3, D2)."
    }),
  hooks: ctx => ({
    "room:peer-joined": payload => ctx.emit("room:peer-joined", payload),
    "room:peer-left": payload => ctx.emit("room:peer-left", payload),
    "room:host-reconnecting": payload => ctx.emit("room:host-reconnecting", payload),
    "room:sync-ready": payload => ctx.emit("room:sync-ready", payload),
    "room:network-warning": payload => ctx.emit("room:network-warning", payload)
  }),
  api: ctx =>
    createStageApi(
      ctx.require(transportPlugin),
      ctx.require(sessionPlugin),
      ctx.require(intentPlugin),
      ctx.require(syncPlugin)
    )
});
/* eslint-enable jsdoc/require-jsdoc */
