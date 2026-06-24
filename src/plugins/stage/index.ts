import { createPlugin } from "@moku-labs/web/browser";
import type { RoomEvents } from "../../contracts";
import { intentPlugin } from "../intent";
import { sessionPlugin } from "../session";
import { syncPlugin } from "../sync";
import { transportPlugin } from "../transport";
import { createStageApi } from "./api";

/* eslint-disable jsdoc/require-jsdoc -- structural wiring callbacks (events/api); domain JSDoc lives in the extracted api/types modules */
/**
 * Stage plugin — Standard tier (HOST-role facade).
 *
 * A thin host surface over Room's four engines (transport, session, intent, sync): every API method
 * delegates via `ctx.require(...)`, the facade owns no state and runs no resource. Re-declares all five
 * `room:*` lifecycle events (contracts §3) so a game plugin with `depends: [stagePlugin]` gets the
 * complete, typed hook surface in one edge (WARN-2 — event visibility is not transitive at the TYPE
 * level: spec/07 §5, spec/14 §7). It does NOT re-emit (forward) them: Moku's runtime event bus is
 * global (every hook for an event name fires on any `emit` of that name, regardless of `depends`), so the
 * engines' own emits already reach a `depends: [stagePlugin]` consumer directly — a forwarding hook that
 * re-emitted the same name would re-trigger itself and recurse infinitely (D19). No `onStart`/`onStop`:
 * the facade manages no resource; the engines own all lifecycle (spec/06). Shipped pre-composed as
 * `roomPlugins.stage = [transport, session, intent, sync, stage]`.
 *
 * @see README.md
 */
export const stagePlugin = createPlugin("stage", {
  // `transportPlugin` is kept in `depends` for dependency-graph/presence completeness (it is the engine
  // that owns the §2 wire + `room:network-warning`); the facade resolves only session/intent/sync via
  // `ctx.require` below. Event visibility does NOT rely on this edge — the facade's own
  // `register.map<RoomEvents>` re-declaration already exposes all five `room:*` to a `depends:[stagePlugin]`
  // consumer (WARN-2 is closed by THAT re-declaration, not by the transport edge).
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
  api: ctx =>
    createStageApi(ctx.require(sessionPlugin), ctx.require(intentPlugin), ctx.require(syncPlugin))
});
/* eslint-enable jsdoc/require-jsdoc */
