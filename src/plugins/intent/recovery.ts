/**
 * @file The `room:host-*` hooks of `intentPlugin`: what a phone's intent stream does while the host is away
 * (§5). `session` decides when the host is gone and when it is back; these hooks move the frames. The host
 * hears `room:host-reconnecting` too, on its own reload, so both hooks are guarded on the role. `endRoom` is for
 * the room that ends while the host is away.
 * @see README.md
 */
import type { Role } from "../session/types";
import { drainBuffer, setBuffering } from "./api";
import type { IntentConfig, IntentState } from "./types";

/**
 * Ends this phone's part in a room that is over: buffering off, buffer dropped. Those frames were for that room's
 * host, and with buffering left on the next room's intents would stay on the phone for good.
 *
 * @param state - The per-app intent state.
 * @param cfg - The frozen intent config.
 * @example
 * ```ts
 * ctx.require(sessionPlugin).onRoomEnded(() => endRoom(ctx.state, ctx.config));
 * ```
 */
export function endRoom(state: IntentState, cfg: Readonly<IntentConfig>): void {
  setBuffering(state, cfg, false);
  drainBuffer(state, cfg);
}

/**
 * Builds the two hook handlers over this app's `state` and frozen `config`. `room:host-reconnecting` turns
 * buffering on, which retires the live window. `room:host-back` turns it off and sends each buffered frame
 * through the delivery tracker with its own `cSeq`, in `cSeq` order: the host de-dupes on a high-water mark,
 * so a lower `cSeq` sent after a higher one would be dropped for good. The buffer is ordered by capture time,
 * which a clock step can reorder.
 *
 * @param state - The per-app intent state.
 * @param cfg - The frozen intent config (`bufferCap` + `bufferMaxAgeMs`).
 * @param role - Resolves this device's session role when a hook runs.
 * @returns The handlers for the `hooks` slot of `intentPlugin`.
 * @example
 * ```ts
 * hooks: ctx =>
 *   createRecoveryHooks(ctx.state, ctx.config, () => ctx.require(sessionPlugin).self().role)
 * ```
 */
export function createRecoveryHooks(
  state: IntentState,
  cfg: Readonly<IntentConfig>,
  role: () => Role
): { "room:host-reconnecting": () => void; "room:host-back": () => void } {
  /* eslint-disable jsdoc/require-jsdoc -- the two handlers are documented on the factory above */
  return {
    "room:host-reconnecting": () => {
      if (role() === "controller") setBuffering(state, cfg, true);
    },
    "room:host-back": () => {
      if (role() !== "controller") return;
      setBuffering(state, cfg, false);
      const buffered = drainBuffer(state, cfg).toSorted((a, b) => a.intent.cSeq - b.intent.cSeq);
      for (const { intent } of buffered) state.delivery?.send(intent);
    }
  };
  /* eslint-enable jsdoc/require-jsdoc */
}
