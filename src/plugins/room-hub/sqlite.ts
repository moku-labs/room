/**
 * @file room-hub DO — SQLite schema + typed helpers (heavy state; written in the output-gate).
 */

/** The `sessions` table DDL (`.planning/specs/07-room-hub.md` §SQLite schema). */
export const SESSIONS_DDL = `CREATE TABLE IF NOT EXISTS sessions (
  peer_id TEXT PRIMARY KEY, role TEXT NOT NULL, sdp_offer TEXT, sdp_answer TEXT,
  candidates TEXT, snapshot TEXT, reclaim_token TEXT, joined_at INTEGER NOT NULL
)`;

/**
 * Ensures the `sessions` table exists on a fresh / cold-woken DO.
 *
 * @param _sql - The DO's `SqlStorage` handle (`this.ctx.storage.sql`).
 * @throws {Error} Always in the skeleton — not implemented.
 * @example
 * ```ts
 * ensureSchema(this.ctx.storage.sql);
 * ```
 */
export function ensureSchema(_sql: SqlStorage): void {
  throw new Error("not implemented");
}
