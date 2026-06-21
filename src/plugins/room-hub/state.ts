/**
 * @file room-hub plugin — state factory skeleton.
 */
import type { Config, State } from "./types";

/**
 * Creates the (empty) room-hub state — the plugin is pure wiring/dispatch.
 *
 * @param _ctx - Minimal context with global registry + resolved config.
 * @param _ctx.global - Global plugin registry.
 * @param _ctx.config - Resolved plugin configuration.
 * @returns The empty state object.
 * @example
 * ```ts
 * const state = createState({ global: {}, config: defaultConfig });
 * ```
 */
export function createState(_ctx: {
  readonly global: Readonly<Record<string, unknown>>;
  readonly config: Readonly<Config>;
}): State {
  return {};
}
