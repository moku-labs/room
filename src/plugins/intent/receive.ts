/**
 * Receive-path wiring for the intent plugin (both role halves of the §4.3 at-least-once loop).
 *
 * `attachIntentReceive` registers EXACTLY ONE transport `Wire.on` handler against the per-app `state`
 * (D14 — never a cached API instance, never a module-level singleton). Host half: for every inbound
 * `t === "intent"` frame it FIRST sends the wire-level `intent-ack` receipt (fresh AND duplicate frames,
 * BEFORE registration/shape/de-dup — a retransmitted frame whose original ack was lost must be re-acked
 * or the sender retransmits to exhaustion), then runs the validate → de-dup (`state.lastApplied`) →
 * dispatch (`state.registry`) pipeline. Controller half: routes `t === "intent-ack"` receipts to this
 * app's delivery tracker (`state.delivery`). Every other frame tag is ignored. The returned `Wire.on`
 * unsubscribe is intentionally dropped — the callback lives on the `transport` channel, which
 * `transport.onStop` tears down wholesale (the plugin's own `onStop` tears down only the delivery
 * tracker's timer). The function takes the destructured per-app pieces (not a `ctx`): `@moku-labs/web`
 * infers `ctx` inline in `index.ts`.
 *
 * @file
 * @see README.md
 */
import type { JsonValue, Wire } from "../transport/protocol";
import type { IntentState } from "./types";
import { validateIntent } from "./validate";

/**
 * Attaches the one-time receive handler for inbound `IntentFrame`s (host half — receipt-ack + pipeline)
 * and `IntentAckFrame`s (controller half — routed to `state.delivery`). Reads/writes the same per-app
 * `state` the API uses, so the receive path and the consumer surface share state without sharing an
 * object instance. Called from `onInit` (dependencies are resolvable; registration is synchronous and
 * opens no resource). The `Wire.on` unsubscribe is deliberately not retained — see the file header.
 *
 * @param state - The per-app intent state (validates against `registry`, de-dups against `lastApplied`,
 *   routes receipts to `delivery`).
 * @param wire - The resolved transport `Wire`: `on` registers the single inbound-frame handler, `send`
 *   returns the wire-level `intent-ack` receipts.
 * @example
 * ```ts
 * // Inside the plugin's onInit:
 * attachIntentReceive(ctx.state, ctx.require(transportPlugin).wire());
 * ```
 */
export function attachIntentReceive(state: IntentState, wire: Wire): void {
  wire.on((peerId, frame) => {
    // Controller half: a wire-level receipt releases the delivery tracker's in-flight window.
    if (frame.t === "intent-ack") {
      state.delivery?.onAck(frame.cSeq);
      return;
    }

    if (frame.t !== "intent") {
      return;
    }

    // 0. Wire-level receipt FIRST — before registration/shape/de-dup, and for duplicates too (§4.3):
    //    acking RECEIPT (not application) is what lets the sender retransmit the SAME frame safely,
    //    and a de-dup-dropped re-send must still be re-acked or a lost ack retransmits to exhaustion.
    wire.send(peerId, { t: "intent-ack", cSeq: frame.cSeq });

    const { name, payload, cSeq } = frame;

    // 1. Must be a registered intent kind
    const registration = state.registry.get(name);
    if (!registration) {
      return;
    }

    // 2. Payload must pass the correctness-only shape-check (D6)
    if (!validateIntent(registration.schema, payload)) {
      return;
    }

    // 3. Idempotent de-dup: drop if cSeq <= lastApplied[peerId] (D4, contracts §4.3)
    const lastSeen = state.lastApplied.get(peerId) ?? -1;
    if (cSeq <= lastSeen) {
      return;
    }

    // Advance the high-water mark
    state.lastApplied.set(peerId, cSeq);

    // 4. Dispatch to the registered handler. `payload` is `unknown` on the wire (contracts §2) but has
    //    passed the correctness-only shape-check above, so it is a valid JsonValue for the handler (D6).
    registration.handler(payload as JsonValue, { peerId, cSeq });
  });
}
