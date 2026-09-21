import type { RoomEvents } from "../../config";
import { createPlugin } from "../../config";
import { createTransportApi } from "./api";
import { tearDownState } from "./channel";
import { DEFAULT_TRANSPORT_CONFIG } from "./config";
import { createTransportState } from "./state";

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
  // @no-resource-check — onStop tears down real resources: peers + heartbeat timer + signaling session.
  // It reads THIS app's own state (D14): since kernel 1.6 onStop gets `{ global, config, state }`.
  // contracts §1.2/§2.4.
  onStop: ({ state }) => tearDownState(state)
});
/* eslint-enable jsdoc/require-jsdoc */
