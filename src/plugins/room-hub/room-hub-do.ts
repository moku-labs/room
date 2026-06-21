/**
 * @file RoomHub Durable Object — Hibernation signaling hub (NOT a plugin; D21/I3).
 */
import { defineDurableObject } from "@moku-labs/worker";

/**
 * Per-room signaling hub: Hibernation accept, a `ClientEnvelope` dispatch switch (join | reclaim | relay —
 * NO gameplay relay, D2), SQLite for heavy state, safe-guarded Alarm TTL with an `evict` push. The base
 * from `defineDurableObject` supplies only `ctx`/`env`; the runtime invokes the handlers below by name, so
 * they are declared without `override`.
 */
export class RoomHub extends defineDurableObject("RoomHub") {
  /**
   * Accepts the WebSocket upgrade (Hibernation), seeds the socket attachment, arms the Alarm.
   *
   * @param _request - The upgrade Request forwarded from the worker entry.
   * @throws {Error} Always in the skeleton — not implemented.
   * @example
   * ```ts
   * const res = await stub.fetch(request);
   * ```
   */
  async fetch(_request: Request): Promise<Response> {
    throw new Error("not implemented");
  }

  /**
   * Dispatches one `ClientEnvelope` (join / reclaim / relay). Enforces the join-window guard (1008) and
   * star topology; writes SDP/ICE to SQLite inside the output-gate.
   *
   * @param _ws - The sending hibernatable WebSocket.
   * @param _message - The raw envelope payload.
   * @throws {Error} Always in the skeleton — not implemented.
   * @example
   * ```ts
   * await room.webSocketMessage(ws, JSON.stringify({ kind: "join", selfId, role: "host" }));
   * ```
   */
  async webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): Promise<void> {
    throw new Error("not implemented");
  }

  /**
   * Clears the peer's attachment/SQLite row and broadcasts `peer-left` to the star subset.
   *
   * @param _ws - The closing WebSocket.
   * @throws {Error} Always in the skeleton — not implemented.
   * @example
   * ```ts
   * await room.webSocketClose(ws);
   * ```
   */
  async webSocketClose(_ws: WebSocket): Promise<void> {
    throw new Error("not implemented");
  }

  /**
   * Safe-guarded TTL: reschedule while sockets are live; push `evict` + `deleteAll()` only at zero.
   *
   * @throws {Error} Always in the skeleton — not implemented.
   * @example
   * ```ts
   * await room.alarm();
   * ```
   */
  async alarm(): Promise<void> {
    throw new Error("not implemented");
  }
}
