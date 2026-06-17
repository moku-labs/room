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
 * @returns A fresh `TransportState` with every handle set to `null`/empty and `role` set to `"idle"`.
 * @example
 * ```ts
 * const state = createTransportState();
 * state.role; // "idle"
 * ```
 */
export function createTransportState(): TransportState {
  return {
    role: "idle",
    selfId: "",
    peers: new Map(),
    session: null,
    heartbeatTimer: null,
    frameConsumer: null,
    peerConnectedCb: null,
    peerLostCb: null,
    warned: new Set()
  };
}
