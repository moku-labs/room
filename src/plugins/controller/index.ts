/**
 * @file `controllerPlugin` wiring harness — Standard tier (CONTROLLER-role facade).
 * @see README.md
 *
 * Thin phone-side facade over the four Room engines (transport / session / intent / sync). Delegates
 * join / read / observe / intent to the resolved engine APIs (`ctx.require`); owns no state and no config.
 * Re-declares + forwards all five `room:*` lifecycle events so a `depends: [controllerPlugin]` game plugin
 * sees the complete typed surface in one edge (event visibility is NOT transitive — spec/07 §5, WARN-2).
 * Requests the iOS Screen Wake Lock through its API (not a lifecycle hook), so there is NO `onStart`/
 * `onStop`. `@moku-labs/web` infers `ctx` inline here (D1 — `PluginContext` is not imported); gameplay
 * rides the §2 wire, never Moku `emit`.
 */
import { createPlugin } from "@moku-labs/web";
import type { RoomEvents } from "../../contracts";
import { intentPlugin } from "../intent";
import { sessionPlugin } from "../session";
import { syncPlugin } from "../sync";
import { transportPlugin } from "../transport";
import { createControllerApi } from "./api";

/* eslint-disable jsdoc/require-jsdoc -- structural wiring callbacks (events/hooks/api); domain JSDoc lives in the extracted api/types modules */
/**
 * `controllerPlugin` — Standard tier (CONTROLLER-role facade) over Room's four engines
 * (transport / session / intent / sync). Delegates join / read / observe / intent to the resolved engine
 * APIs; owns no state. Re-declares + forwards all five `room:*` events (WARN-2) so a
 * `depends: [controllerPlugin]` game plugin sees the complete typed lifecycle surface. Requests the iOS
 * Screen Wake Lock through its API to keep the DataChannel alive (D11). Gameplay rides the §2 wire, never
 * Moku `emit`.
 *
 * @see README.md
 */
export const controllerPlugin = createPlugin("controller", {
  depends: [transportPlugin, sessionPlugin, intentPlugin, syncPlugin],
  events: register =>
    register.map<RoomEvents>({
      "room:peer-joined":
        "A controller's channel reached connected and was added to the roster (§6).",
      "room:peer-left":
        "A controller left or was heartbeat-declared dead (§2.4); removed from roster.",
      "room:host-reconnecting":
        "Host tab reloaded; client-side recovery in flight (§5). Show reconnecting UX.",
      "room:sync-ready": "First full snapshot applied; the read-only replica is now readable (§4).",
      "room:network-warning":
        "Connectivity hard-failure for failure UX (D2): ice-failed | rendezvous-unreachable | channel-closed."
    }),
  hooks: ctx => ({
    "room:peer-joined": payload => ctx.emit("room:peer-joined", payload),
    "room:peer-left": payload => ctx.emit("room:peer-left", payload),
    "room:host-reconnecting": payload => ctx.emit("room:host-reconnecting", payload),
    "room:sync-ready": payload => ctx.emit("room:sync-ready", payload),
    "room:network-warning": payload => ctx.emit("room:network-warning", payload)
  }),
  api: ctx =>
    createControllerApi(
      ctx.require(transportPlugin),
      ctx.require(sessionPlugin),
      ctx.require(intentPlugin),
      ctx.require(syncPlugin)
    )
});
/* eslint-enable jsdoc/require-jsdoc */
