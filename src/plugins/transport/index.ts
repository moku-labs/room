import type { RoomEvents } from "../../config";
import { createPlugin } from "../../config";
import { createTransportApi } from "./api";
import { tearDownState } from "./channel";
import { DEFAULT_TRANSPORT_CONFIG } from "./config";
import { createTransportState } from "./state";
import type { TransportState } from "./types";

// D14 per-instance teardown registry — module-level `const` (NOT a `let` holding an instance). Maps each
// app's own frozen `ctx.global` config to its live TransportState so `onStop` (which gets `{ global }`
// only — no `ctx.state`) can recover EXACTLY this app's state. Room composes multiple app instances in
// one process, so a singleton `let` would be overwritten by the next createApp. Key type `object`
// (`ctx.global` is the host framework's frozen global, not `TransportConfig`; D15). Auto-GC.
const teardownRegistry = new WeakMap<object, TransportState>();

/* eslint-disable jsdoc/require-jsdoc -- structural wiring callbacks (events/api/onStart/onStop); domain JSDoc lives in the extracted state/api/channel modules */
/**
 * Transport plugin — Complex tier.
 *
 * Room's networking floor: WebRTC `RTCPeerConnection` lifecycle, the typed `Wire` DataChannel channel
 * (chunk/reassemble, backpressure, mandatory heartbeat, open-timeout retry), and the general `Signaling`
 * seam (publicRendezvous default + inMemory for tests). Emits only `room:network-warning`. No Room deps
 * (Wave 1). Gameplay rides the `Wire`, never Moku `emit` (spec/07 section 3; contracts three planes).
 *
 * @see README.md
 */
export const transportPlugin = createPlugin("transport", {
  config: DEFAULT_TRANSPORT_CONFIG,
  createState: createTransportState,
  events: register => ({
    "room:network-warning": register<RoomEvents["room:network-warning"]>(
      "A connectivity hard-failure surfaced: ice-failed | rendezvous-unreachable | channel-closed."
    )
  }),
  api: ctx =>
    createTransportApi(ctx.state, ctx.config, reason =>
      ctx.emit("room:network-warning", { reason })
    ),
  // @no-resource-check — onStart/onStop manage real resources: peers + heartbeat timer + signaling
  // session, torn down via the D14 per-instance registry (onStop gets `{ global }` only). contracts §1.2/§2.4.
  onStart: ctx => {
    teardownRegistry.set(ctx.global, ctx.state);
  },
  onStop: async ctx => {
    const s = teardownRegistry.get(ctx.global);
    if (s) {
      await tearDownState(s);
      teardownRegistry.delete(ctx.global);
    }
  }
});
/* eslint-enable jsdoc/require-jsdoc */
