/**
 * @file Lightweight in-test doubles for the RoomHub DO's Hibernation + SQLite surface (Cycle-2 W3).
 *
 * The real DO runs in `workerd` (WebSocketPair, `acceptWebSocket`, `SqlStorage`); the DO's `fetch()`
 * Hibernation accept is exercised by Wave-4's Playwright-against-`wrangler dev` run. These fakes cover the
 * dispatch surface (`webSocketMessage` / `webSocketClose` / `alarm`) that runs purely against the DO's
 * `ctx`, so the join-window guard, cap, star topology, relay opacity, reclaim, and Alarm-TTL logic are
 * unit-testable under node/bun without the workerd pool (the DO-test-infra decision for this wave).
 * @see ../room-hub-do
 * @see ../sqlite
 */
import type { ServerEnvelope } from "../../../contracts";
import { RoomHub } from "../room-hub-do";

/** One emulated `sessions` row. */
type FakeRow = Record<string, unknown>;

/** Minimal `SqlStorage` emulator backing the `sessions` table — recognizes the exact queries sqlite.ts issues. */
export class FakeSql {
  /** The emulated table, keyed by `peer_id`. */
  readonly rows = new Map<string, FakeRow>();

  /**
   * Emulates `SqlStorage.exec`: routes by leading keyword to the in-memory table and returns a cursor
   * with a `toArray()` (the only cursor method sqlite.ts uses).
   *
   * @param query - The SQL text.
   * @param binds - The positional bind parameters.
   * @returns A cursor whose `toArray()` yields the matching projected rows.
   * @example
   * ```ts
   * sql.exec("SELECT peer_id, role FROM sessions").toArray();
   * ```
   */
  exec(query: string, ...binds: unknown[]): { toArray(): FakeRow[] } {
    const q = query.trim();
    if (q.startsWith("CREATE")) return cursor([]);
    if (q.startsWith("INSERT")) {
      const [peerId, role, reclaimToken, joinedAt] = binds;
      this.rows.set(String(peerId), {
        peer_id: peerId,
        role,
        reclaim_token: reclaimToken,
        joined_at: joinedAt
      });
      return cursor([]);
    }
    if (q.startsWith("DELETE")) {
      this.rows.delete(String(binds[0]));
      return cursor([]);
    }
    if (q.startsWith("UPDATE")) {
      const row = this.rows.get(String(binds[1]));
      if (row) row[updateColumn(q)] = binds[0];
      return cursor([]);
    }
    // SELECT peer_id, role FROM sessions [WHERE reclaim_token = ?]
    const all = [...this.rows.values()];
    const matched = q.includes("reclaim_token")
      ? all.filter(row => row.reclaim_token === binds[0])
      : all;
    return cursor(matched.map(row => ({ peer_id: row.peer_id, role: row.role })));
  }
}

/** A cursor double exposing the single `toArray()` method sqlite.ts consumes. */
function cursor(rows: FakeRow[]): { toArray(): FakeRow[] } {
  return { toArray: () => rows };
}

/**
 * Maps an `UPDATE sessions SET <col> = ?` query to the column it writes (flat — no nested ternary).
 *
 * @param query - The UPDATE SQL text.
 * @returns The target column name.
 * @example
 * ```ts
 * updateColumn("UPDATE sessions SET sdp_offer = ? WHERE peer_id = ?"); // "sdp_offer"
 * ```
 */
function updateColumn(query: string): string {
  if (query.includes("sdp_offer")) return "sdp_offer";
  if (query.includes("sdp_answer")) return "sdp_answer";
  return "candidates";
}

/** A Hibernatable-WebSocket double recording sent envelopes, the attachment, and the close code/reason. */
export class FakeSocket {
  /** The current serialized attachment (or `undefined` before one is seeded). */
  attachment: unknown = undefined;
  /** Parsed `ServerEnvelope`s the DO sent to this socket, in order. */
  readonly sent: ServerEnvelope[] = [];
  /** The close `{code, reason}` once `close()` was called, else `null`. */
  closed: { code: number; reason: string } | null = null;

  serializeAttachment(value: unknown): void {
    this.attachment = value;
  }
  deserializeAttachment(): unknown {
    return this.attachment ?? null;
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data) as ServerEnvelope);
  }
  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }

  /** The most recent envelope sent to this socket, or `undefined`. */
  lastSent(): ServerEnvelope | undefined {
    return this.sent.at(-1);
  }
}

/** A fake DO harness: the `RoomHub` instance plus its emulated `ctx` table/socket-set accessors. */
export type FakeRoom = {
  /** The DO under test. */
  readonly room: RoomHub;
  /** The emulated SQLite store. */
  readonly sql: FakeSql;
  /** The live socket set the DO reads via `ctx.getWebSockets()`. */
  readonly sockets: FakeSocket[];
  /**
   * Registers a freshly-"accepted" socket (seeded `{peerId:null, role:null, openedAt}`) in the socket set.
   *
   * @param openedAt - The socket's accept timestamp (drives the join-window guard). Default `Date.now()`.
   * @returns The added {@link FakeSocket}.
   */
  addSocket(openedAt?: number): FakeSocket;
  /** The current armed alarm timestamp, or `null`. */
  alarmAt(): number | null;
  /** Whether `storage.deleteAll()` has been called. */
  isDeleted(): boolean;
};

/**
 * Builds a {@link FakeRoom}: a `RoomHub` wired to an emulated `ctx` (SQLite + socket set + alarm/storage),
 * so the dispatch handlers can be driven directly without `workerd`.
 *
 * @returns The fake DO harness.
 * @example
 * ```ts
 * const { room, addSocket } = makeFakeRoom();
 * const host = addSocket();
 * await room.webSocketMessage(host as unknown as WebSocket, JSON.stringify({ kind: "join", selfId: "h", role: "host" }));
 * ```
 */
export function makeFakeRoom(): FakeRoom {
  const sql = new FakeSql();
  const sockets: FakeSocket[] = [];
  let alarmAt: number | null = null;
  let deleted = false;

  const storage = {
    sql,
    getAlarm: async (): Promise<number | null> => alarmAt,
    setAlarm: async (time: number): Promise<void> => {
      alarmAt = time;
    },
    deleteAll: async (): Promise<void> => {
      deleted = true;
      sql.rows.clear();
    }
  };

  const ctx = {
    storage,
    acceptWebSocket: (ws: FakeSocket): void => {
      sockets.push(ws);
    },
    getWebSockets: (): FakeSocket[] => sockets
  };

  const room = new RoomHub(
    ctx as unknown as DurableObjectState,
    {} as unknown as Record<string, unknown>
  );

  return {
    room,
    sql,
    sockets,
    addSocket(openedAt = Date.now()): FakeSocket {
      const ws = new FakeSocket();
      ws.serializeAttachment({ peerId: null, role: null, openedAt });
      sockets.push(ws);
      return ws;
    },
    alarmAt: () => alarmAt,
    isDeleted: () => deleted
  };
}

/**
 * Casts a {@link FakeSocket} to the `WebSocket` the DO handlers expect (the double implements only the
 * Hibernation subset they touch).
 *
 * @param ws - The fake socket.
 * @returns The same object typed as a `WebSocket`.
 * @example
 * ```ts
 * await room.webSocketMessage(asWs(host), raw);
 * ```
 */
export function asWs(ws: FakeSocket): WebSocket {
  return ws as unknown as WebSocket;
}
