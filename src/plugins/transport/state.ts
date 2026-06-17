/**
 * @file Per-app state factory for `transportPlugin` (idle, no peers, no session).
 * @see README.md
 */
import type { TransportState } from "./types";

/**
 * Creates the initial per-app `TransportState`: `role: "idle"`, an empty `peers` map, no signaling
 * session, no timers, no frame consumer, and an empty warn de-dup set. Per-`createApp` via `ctx.state`
 * (D14) — never a module-level singleton.
 *
 * @example
 * ```ts
 * const state = createTransportState();
 * state.role; // "idle"
 * ```
 */
export function createTransportState(): TransportState {
  throw new Error("not implemented");
}
