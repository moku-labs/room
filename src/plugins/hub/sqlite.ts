/**
 * @file hub DO — SQLite schema + typed helpers (heavy state; written in the output-gate so a
 * Hibernation wake mid-handshake never drops it). The `sessions` table is the per-room roster: one row
 * per live peer carrying its role, the host's reclaim token, and the in-flight SDP/ICE. Attachments hold
 * only `{peerId, role}`; ALL heavy state lives here (`.planning/specs/07-hub.md` §State/§SQLite).
 * @see ./hub-do
 */
import type { PeerId, SignalMsg } from "../transport/protocol";

/** A peer's role in the star (host hub vs passive controller). */
export type Role = "host" | "controller";

/** A roster row projected from `sessions` — the subset the DO dispatch reads back. */
export type SessionRow = {
  /** The peer's stable signaling id (§6). */
  readonly peerId: PeerId;
  /** The peer's star role. */
  readonly role: Role;
};

/** The `sessions` table DDL (`.planning/specs/07-hub.md` §SQLite schema). */
export const SESSIONS_DDL = `CREATE TABLE IF NOT EXISTS sessions (
  peer_id TEXT PRIMARY KEY, role TEXT NOT NULL, sdp_offer TEXT, sdp_answer TEXT,
  candidates TEXT, snapshot TEXT, reclaim_token TEXT, joined_at INTEGER NOT NULL
)`;

/**
 * Narrows a raw `role` cell to the {@link Role} union (defaults to `"controller"` for any non-`"host"`
 * value), keeping the rest of the DO free of `as` casts on SQLite reads.
 *
 * @param raw - The raw `role` column value.
 * @returns The narrowed role.
 * @example
 * ```ts
 * const role = toRole(row.role); // "host" | "controller"
 * ```
 */
function toRole(raw: unknown): Role {
  return raw === "host" ? "host" : "controller";
}

/**
 * Ensures the `sessions` table exists on a fresh / cold-woken DO. Idempotent (`IF NOT EXISTS`), so it is
 * safe to call on every Hibernation wake before touching the table.
 *
 * @param sql - The DO's `SqlStorage` handle (`this.ctx.storage.sql`).
 * @example
 * ```ts
 * ensureSchema(this.ctx.storage.sql);
 * ```
 */
export function ensureSchema(sql: SqlStorage): void {
  sql.exec(SESSIONS_DDL);
}

/**
 * Inserts (or replaces) one peer's session row inside the output-gate. The host row carries the reclaim
 * token; controllers store theirs too (harmless — only the host's is ever presented on `reclaim`).
 *
 * @param sql - The DO's `SqlStorage` handle.
 * @param peerId - The joining peer's stable id (§6).
 * @param role - The peer's star role.
 * @param reclaimToken - The minted host re-entry token (§5.1).
 * @param joinedAt - Epoch-ms the peer joined.
 * @example
 * ```ts
 * insertSession(sql, "host_root", "host", token, Date.now());
 * ```
 */
export function insertSession(
  sql: SqlStorage,
  peerId: PeerId,
  role: Role,
  reclaimToken: string,
  joinedAt: number
): void {
  sql.exec(
    "INSERT OR REPLACE INTO sessions (peer_id, role, reclaim_token, joined_at) VALUES (?, ?, ?, ?)",
    peerId,
    role,
    reclaimToken,
    joinedAt
  );
}

/**
 * Removes a peer's session row (on `webSocketClose` or when a reclaiming host supersedes the old row).
 *
 * @param sql - The DO's `SqlStorage` handle.
 * @param peerId - The peer whose row to delete.
 * @example
 * ```ts
 * deleteSession(sql, "p_ab12");
 * ```
 */
export function deleteSession(sql: SqlStorage, peerId: PeerId): void {
  sql.exec("DELETE FROM sessions WHERE peer_id = ?", peerId);
}

/**
 * Lists every live peer's id + role (the roster), used to compute the star-correct join-ack `peers`.
 *
 * @param sql - The DO's `SqlStorage` handle.
 * @returns One {@link SessionRow} per persisted peer.
 * @example
 * ```ts
 * const controllers = listPeers(sql).filter(p => p.role === "controller");
 * ```
 */
export function listPeers(sql: SqlStorage): SessionRow[] {
  const rows = sql.exec("SELECT peer_id, role FROM sessions").toArray();
  return rows.map(row => ({ peerId: String(row.peer_id), role: toRole(row.role) }));
}

/**
 * Looks up the peer that owns a presented reclaim token (the host-reclaim verification, §5.1). Returns
 * `null` when no row matches — the DO then rejects the `reclaim`.
 *
 * @param sql - The DO's `SqlStorage` handle.
 * @param token - The reclaim token presented on a `{kind:"reclaim"}` envelope.
 * @returns The matching {@link SessionRow}, or `null` when the token is unknown.
 * @example
 * ```ts
 * const owner = findPeerByReclaimToken(sql, env.reclaimToken);
 * ```
 */
export function findPeerByReclaimToken(sql: SqlStorage, token: string): SessionRow | null {
  const rows = sql
    .exec("SELECT peer_id, role FROM sessions WHERE reclaim_token = ?", token)
    .toArray();
  const row = rows[0];
  return row ? { peerId: String(row.peer_id), role: toRole(row.role) } : null;
}

/**
 * Persists an in-flight handshake `SignalMsg` to the sender's row inside the output-gate, so a
 * Hibernation wake mid-handshake never loses the SDP/ICE (§State). The DO never inspects the payload
 * beyond its `kind` discriminant — there is NO gameplay path (D2/D21).
 *
 * @param sql - The DO's `SqlStorage` handle.
 * @param fromPeer - The relaying peer (whose row records the in-flight message).
 * @param msg - The opaque offer / answer / candidate being relayed (§1.1).
 * @example
 * ```ts
 * recordRelay(sql, "host_root", { kind: "offer", sdp });
 * ```
 */
export function recordRelay(sql: SqlStorage, fromPeer: PeerId, msg: SignalMsg): void {
  switch (msg.kind) {
    case "offer": {
      sql.exec("UPDATE sessions SET sdp_offer = ? WHERE peer_id = ?", msg.sdp, fromPeer);
      return;
    }
    case "answer": {
      sql.exec("UPDATE sessions SET sdp_answer = ? WHERE peer_id = ?", msg.sdp, fromPeer);
      return;
    }
    default: {
      // candidate — store the latest trickled candidate (live delivery carries the full stream; this is
      // the Hibernation-survival backstop only).
      sql.exec(
        "UPDATE sessions SET candidates = ? WHERE peer_id = ?",
        JSON.stringify(msg.candidate),
        fromPeer
      );
    }
  }
}
