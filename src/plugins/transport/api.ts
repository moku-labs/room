/**
 * @file `transportPlugin` API factory — `connect`/`wire`/`disconnect`/`peers`/`close`.
 * @see README.md
 *
 * The public surface is small: `connect` is the on-demand entry point (called by `sessionPlugin` on room
 * create/join — NOT at app boot), `wire()` hands the typed channel to the engines, and `disconnect` /
 * `close` tear down. Operates on the per-app `state` + frozen `config` the wiring harness passes (D14).
 * Gameplay rides the `Wire`, never Moku `emit`. The factory takes the destructured per-app pieces (not a
 * `ctx`): `@moku-labs/web` infers `ctx` inline in `index.ts`, so the declared `room:network-warning`
 * event flows into the bound `emitWarning` closure.
 */
import type { RoomEvents } from "../../contracts";
import type { TransportApi, TransportConfig, TransportState } from "./types";

/**
 * Builds the `transportPlugin` API for one app instance from its per-app `state`, frozen `config`, and a
 * narrowed `emitWarning` closure (the wiring harness binds `ctx.emit`). `connect` joins the signaling
 * room (host active / controller passive) and wires the handshake glue; `wire()` returns the stable
 * `Wire`; `disconnect` tears down one peer; `peers()` snapshots the live ids; `close()` runs the full
 * teardown against `state` (the same sequence `onStop` runs via the registry).
 *
 * @param state - The per-app transport state (peer map, signaling session, timers).
 * @param cfg - The frozen per-app transport config (ICE servers, timings, chunk threshold).
 * @param emitWarning - Narrowed `ctx.emit` closure for the single owned `room:network-warning` event.
 * @throws {Error} Always — skeleton stub.
 * @example
 * ```ts
 * const api = createTransportApi(ctx.state, ctx.config, reason =>
 *   ctx.emit("room:network-warning", { reason })
 * );
 * await api.connect({ role: "host", selfId: "host_root", code: "K7M2QX" });
 * ```
 */
export function createTransportApi(
  state: TransportState,
  cfg: Readonly<TransportConfig>,
  emitWarning: (reason: RoomEvents["room:network-warning"]["reason"]) => void
): TransportApi {
  throw new Error("not implemented");
}
