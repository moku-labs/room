/**
 * Host receive-path wiring for the intent plugin.
 *
 * `attachIntentReceive` registers EXACTLY ONE transport `Wire.on` handler against the per-app `state`
 * (D14 — never a cached API instance, never a module-level singleton). The handler filters to
 * `frame.t === "intent"`, runs the validate → de-dup (`state.lastApplied`) → dispatch (`state.registry`)
 * pipeline, and ignores every other frame tag. The returned `Wire.on` unsubscribe is intentionally
 * dropped — the callback lives on the `transport` channel, which `transport.onStop` tears down wholesale,
 * so `intentPlugin` needs no `onStop`. The function takes the destructured per-app pieces (not a `ctx`):
 * `@moku-labs/web` infers `ctx` inline in `index.ts`.
 *
 * @file
 * @see README.md
 */
import type { JsonValue, Wire } from "../transport/protocol";
import type { IntentState } from "./types";
import { validateIntent } from "./validate";

/**
 * Attaches the one-time host receive handler for inbound `IntentFrame`s. Reads/writes the same per-app
 * `state` the API uses, so the receive path and the consumer surface share state without sharing an
 * object instance. Called from `onInit` (dependencies are resolvable; registration is synchronous and
 * opens no resource). The `Wire.on` unsubscribe is deliberately not retained — see the file header for
 * why there is no `onStop`.
 *
 * @param state - The per-app intent state (validates against `registry`, de-dups against `lastApplied`).
 * @param wire - The resolved transport `Wire` whose `on` registers the single inbound-frame handler.
 * @example
 * ```ts
 * // Inside the plugin's onInit:
 * attachIntentReceive(ctx.state, ctx.require(transportPlugin).wire());
 * ```
 */
export function attachIntentReceive(state: IntentState, wire: Wire): void {
  wire.on((peerId, frame) => {
    if (frame.t !== "intent") {
      return;
    }

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
