/**
 * @file room-hub plugin — state factory skeleton.
 */
import type { State } from "./types";

/**
 * Creates the (empty) room-hub state — the plugin is pure wiring/dispatch.
 *
 * Takes no context: room-hub holds no cross-request state (env is threaded per call), so the factory
 * ignores the framework's `MinimalContext` argument entirely. A zero-arg `() => State` is assignable
 * where core expects `(ctx) => State`, mirroring `createSessionState`.
 *
 * @returns The empty state object.
 * @example
 * ```ts
 * const state = createState();
 * ```
 */
export function createState(): State {
  return {};
}
