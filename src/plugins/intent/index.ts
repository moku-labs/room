/**
 * @file `intentPlugin` wiring harness — Standard tier. Composes state + api + the receive path.
 * @see README.md
 *
 * Controller → host typed-input contract: typed intent registration + shape-checked, idempotent,
 * AT-LEAST-ONCE routing over the transport `Wire` (NOT emit) — live frames are receipt-acked by the
 * host and retransmitted (bounded) by the controller's delivery tracker — plus the reconnect
 * intent-buffer that `sessionPlugin` flushes. Declares ONE event (`room:intent-undeliverable`, the
 * terminal retransmit-budget verdict) via the register-callback pattern (spec/14 §2). Owns ONE resource:
 * the delivery tracker's retransmit timer, torn down via the D14 per-instance registry (the `Wire.on`
 * callback itself is still subsumed by `transport.onStop`). Depends on transport + session. No explicit
 * generics — Config/State/Api all infer from this spec object (R1). The extracted factories take
 * destructured per-app pieces; `@moku-labs/web` infers `ctx` inline here, so `api`/`onInit` bind the
 * resolved transport `Wire` + session host-id + the narrowed emit.
 */
import type { RoomEvents } from "../../config";
import { createPlugin } from "../../config";
import { sessionPlugin } from "../session";
import { transportPlugin } from "../transport";
import { createIntentApi } from "./api";
import { DEFAULT_INTENT_CONFIG } from "./config";
import { attachIntentReceive } from "./receive";
import { createIntentState } from "./state";
import type { IntentState } from "./types";

// D14 per-instance teardown registry — module-level `const` (NOT a `let` holding an instance). Maps each
// app's own frozen `ctx.global` config to that app's mutable `IntentState` (and through it the shared
// `state.delivery` tracker), so `onStop` — which gets `{ global }` only (no `require`, no `ctx.state`) —
// can reach EXACTLY this app's delivery tracker to clear its retransmit timer. Room composes multiple
// app instances in one process, so a singleton `let` would be overwritten by the next createApp and
// `app1.stop()` would clear `app2`'s timer. Auto-GC.
const teardownRegistry = new WeakMap<object, IntentState>();

/* eslint-disable jsdoc/require-jsdoc -- structural wiring callbacks (events/api/onInit/onStart/onStop); domain JSDoc lives in the extracted state/api/delivery/receive modules */
/**
 * `intentPlugin` — Standard tier.
 *
 * Controller → host typed-input contract: typed intent registration + shape-checked, idempotent,
 * at-least-once routing over the transport `Wire` (NOT emit), plus the reconnect intent-buffer that
 * `sessionPlugin` flushes. Live sends are receipt-acked (`intent-ack`) and retransmitted (bounded,
 * doubling backoff) until acked; exhaustion emits the ONE event this plugin owns —
 * `room:intent-undeliverable`. Owns the retransmit timer as its single resource (`onStart`/`onStop`
 * pair over the D14 registry). Depends on transport + session.
 *
 * @see README.md
 */
export const intentPlugin = createPlugin("intent", {
  depends: [transportPlugin, sessionPlugin],
  config: DEFAULT_INTENT_CONFIG,
  createState: createIntentState,
  events: register =>
    register.map<Pick<RoomEvents, "room:intent-undeliverable">>({
      "room:intent-undeliverable":
        "A live intent exhausted its bounded retransmit budget with no wire-level receipt; the wire is dead for this controller's intent stream and every intent queued behind it drops with its own event."
    }),
  api: ctx =>
    createIntentApi(
      ctx.state,
      ctx.config,
      ctx.require(transportPlugin).wire(),
      () => ctx.require(sessionPlugin).hostId(),
      payload => ctx.emit("room:intent-undeliverable", payload)
    ),
  onInit: ctx => attachIntentReceive(ctx.state, ctx.require(transportPlugin).wire()),
  // @no-resource-check — onStart/onStop pair tears down the delivery tracker's retransmit timer via the
  // D14 per-instance registry (onStop gets `{ global }` only — no `ctx.state`). contracts section 4.3.
  onStart: ctx => {
    teardownRegistry.set(ctx.global, ctx.state);
  },
  onStop: ctx => {
    teardownRegistry.get(ctx.global)?.delivery?.stop();
    teardownRegistry.delete(ctx.global);
  }
});
/* eslint-enable jsdoc/require-jsdoc */
