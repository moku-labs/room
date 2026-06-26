/**
 * @file Hub Durable Object — Hibernation signaling hub (NOT a plugin; D21/I3).
 *
 * Per-room signaling hub reached via `env.ROOM_HUB.getByName(code)`. Speaks the `00-contracts.md` §1.3
 * `ClientEnvelope`/`ServerEnvelope` protocol over a Hibernatable WebSocket: a discriminated `kind` switch
 * (`join` / `reclaim` / `relay` — **NO gameplay-relay case**, D2/D21), star-topology enforcement
 * (passive↔passive never announced), SQLite for the roster + reclaim token + in-flight SDP/ICE,
 * `{peerId, role}` in socket attachments, and a safe-guarded Alarm TTL. The DO and the `serverSignaling`
 * adapter (`../transport/adapters/server-impl.ts`) are the two ends of that one protocol; the
 * `inMemory({ server: true })` simulator speaks it too, so every path is testable before deploy.
 *
 * A plain DO class (no base-class import) so it loads under node for the fake-driven unit tests; the
 * workerd runtime instantiates it with `(ctx, env)` and invokes the handlers below by name.
 * @see ../transport/protocol
 * @see ./sqlite
 */
import type { ClientEnvelope, PeerId, ServerEnvelope } from "../transport/protocol";
import { MAX_CONTROLLERS } from "../transport/protocol";
import { defaultConfig } from "./config";
import {
  deleteSession,
  ensureSchema,
  findPeerByReclaimToken,
  insertSession,
  listPeers,
  type Role,
  recordRelay
} from "./sqlite";

/**
 * Per-socket identity, stored via `serializeAttachment` (≤16 KB; Hibernation-durable). `peerId`/`role`
 * are `null` between accept and the first `join`/`reclaim`; `openedAt` stamps the join-window guard (D24).
 */
type Attachment = {
  /** The peer's stable id once joined, else `null`. */
  readonly peerId: PeerId | null;
  /** The peer's star role once joined, else `null`. */
  readonly role: Role | null;
  /** Epoch-ms the socket was accepted — the join-window guard reference (D24). */
  readonly openedAt: number;
};

/**
 * Whether two roles form a valid star edge (host↔controller only). controller↔controller and host↔host
 * are never paired, so passive controllers are never announced to each other (§1.1 star topology).
 *
 * @param a - One peer's role.
 * @param b - The other peer's role.
 * @returns `true` when the pair is a host↔controller edge.
 * @example
 * ```ts
 * isStarPair("host", "controller"); // true
 * isStarPair("controller", "controller"); // false
 * ```
 */
function isStarPair(a: Role, b: Role): boolean {
  return a !== b;
}

/**
 * Whether `value` is a non-empty string — the required-field guard for inbound frames (D24).
 *
 * @param value - The candidate value.
 * @returns `true` when `value` is a string of length ≥ 1.
 * @example
 * ```ts
 * if (!isNonEmptyString(frame.selfId)) return null;
 * ```
 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Parses + VALIDATES a raw inbound frame into a {@link ClientEnvelope}, returning `null` for non-JSON,
 * non-object, unknown-`kind`, OR a payload missing its required fields (the DO replies
 * `{kind:"error", code:1003}` for those). Per-kind field validation (D24 hardening) keeps a malformed
 * frame off the internet-facing endpoint — e.g. a `{kind:"join"}` with no `selfId` never reaches SQLite.
 *
 * @param raw - The raw `webSocketMessage` payload (string or binary).
 * @returns The validated client envelope, or `null` when unrecognized/malformed.
 * @example
 * ```ts
 * const env = parseClientEnvelope(raw);
 * ```
 */
function parseClientEnvelope(raw: string | ArrayBuffer): ClientEnvelope | null {
  if (typeof raw !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const frame = parsed as Record<string, unknown>;
  switch (frame.kind) {
    case "join": {
      const ok =
        isNonEmptyString(frame.selfId) && (frame.role === "host" || frame.role === "controller");
      return ok ? (parsed as ClientEnvelope) : null;
    }
    case "reclaim": {
      const ok = isNonEmptyString(frame.selfId) && isNonEmptyString(frame.reclaimToken);
      return ok ? (parsed as ClientEnvelope) : null;
    }
    case "relay": {
      const ok = isNonEmptyString(frame.to) && typeof frame.msg === "object" && frame.msg !== null;
      return ok ? (parsed as ClientEnvelope) : null;
    }
    default: {
      return null;
    }
  }
}

/**
 * Serializes and sends one {@link ServerEnvelope} to a socket.
 *
 * @param ws - The destination WebSocket.
 * @param envelope - The server frame to deliver.
 * @example
 * ```ts
 * sendEnvelope(ws, { kind: "join-ack", peers, reclaimToken });
 * ```
 */
function sendEnvelope(ws: WebSocket, envelope: ServerEnvelope): void {
  ws.send(JSON.stringify(envelope));
}

/**
 * Reads a socket's typed {@link Attachment} (or `null` before one is seeded).
 *
 * @param ws - The WebSocket whose attachment to read.
 * @returns The attachment, or `null`.
 * @example
 * ```ts
 * const att = readAttachment(ws);
 * ```
 */
function readAttachment(ws: WebSocket): Attachment | null {
  const raw: unknown = ws.deserializeAttachment();
  return raw === null || raw === undefined ? null : (raw as Attachment);
}

/**
 * Per-room signaling hub — a plain Cloudflare Durable Object class (no base-class import, so it loads under
 * node for the fake-driven unit tests; the workerd runtime instantiates it with `(ctx, env)`).
 * Hibernation-based: heavy state lives in SQLite and is re-read on each message, so a wake mid-handshake
 * never drops it.
 */
export class Hub {
  /**
   * Stores the Durable Object state for the handlers below; the workerd runtime instantiates the DO with
   * `(ctx, env)`. `env` is unused — the hub reads its heavy state from SQLite via `ctx.storage`.
   *
   * @param ctx - The Durable Object state (SQLite storage, hibernatable sockets, alarms) the runtime supplies.
   * @param _env - The per-DO env (unused).
   * @example
   * ```ts
   * const hub = new Hub(ctx, env); // workerd-instantiated; unit tests pass a fake ctx
   * ```
   */
  constructor(
    private readonly ctx: DurableObjectState,
    _env: unknown
  ) {}
  /**
   * Accepts the WebSocket upgrade (Hibernation), seeds the socket attachment as `{peerId:null,
   * role:null, openedAt}`, ensures the SQLite schema, and arms the idle-TTL Alarm if unset.
   *
   * @param _request - The upgrade Request forwarded from the worker entry.
   * @returns The `101 Switching Protocols` response carrying the client socket.
   * @example
   * ```ts
   * const res = await stub.fetch(request);
   * ```
   */
  async fetch(_request: Request): Promise<Response> {
    ensureSchema(this.ctx.storage.sql);
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    const attachment: Attachment = { peerId: null, role: null, openedAt: Date.now() };
    server.serializeAttachment(attachment);
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + defaultConfig.roomTtlMs);
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Dispatches one {@link ClientEnvelope} (`join` / `reclaim` / `relay`). Unknown / unparsable frames get
   * `{kind:"error", code:1003}`. There is NO gameplay-relay case (D2/D21).
   *
   * @param ws - The sending hibernatable WebSocket.
   * @param raw - The raw envelope payload.
   * @example
   * ```ts
   * await room.webSocketMessage(ws, JSON.stringify({ kind: "join", selfId, role: "host" }));
   * ```
   */
  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const envelope = parseClientEnvelope(raw);
    if (!envelope) {
      sendEnvelope(ws, { kind: "error", code: 1003, message: "unknown kind" });
      return;
    }
    switch (envelope.kind) {
      case "join": {
        this.onJoin(ws, envelope);
        return;
      }
      case "reclaim": {
        this.onReclaim(ws, envelope);
        return;
      }
      case "relay": {
        this.onRelay(ws, envelope);
        return;
      }
      default: {
        sendEnvelope(ws, { kind: "error", code: 1003, message: "unknown kind" });
      }
    }
  }

  /**
   * Handles a socket close: announces `peer-left` to the star subset, and drops a CONTROLLER's SQLite row
   * so the roster reflects only live peers. The HOST's row is deliberately KEPT — it carries the reclaim
   * token, and a host reload's `{kind:"reclaim"}` races just behind this close, so deleting here would make
   * `findPeerByReclaimToken` miss and reject the warm re-entry (§5.1, D25). The reclaim path supersedes the
   * stale host row, and the idle Alarm GCs it (`deleteAll()`) if the host never returns. Star fan-out reads
   * LIVE sockets via `getWebSockets()` — never this row — so a lingering host row never mis-announces.
   *
   * @param ws - The closing WebSocket.
   * @example
   * ```ts
   * await room.webSocketClose(ws);
   * ```
   */
  async webSocketClose(ws: WebSocket): Promise<void> {
    const att = readAttachment(ws);
    if (!att?.peerId || !att.role) return;
    if (att.role === "controller") deleteSession(this.ctx.storage.sql, att.peerId);
    this.announce(ws, { kind: "peer-left", peerId: att.peerId }, att.role);
  }

  /**
   * Safe-guarded idle TTL: a still-live room (sockets attached, possibly hibernated) reschedules; only a
   * truly empty room is torn down with `deleteAll()` (§Lifecycle, D25).
   *
   * @example
   * ```ts
   * await room.alarm();
   * ```
   */
  async alarm(): Promise<void> {
    const sockets = this.ctx.getWebSockets();
    if (sockets.length > 0) {
      await this.ctx.storage.setAlarm(Date.now() + defaultConfig.roomTtlMs);
      return;
    }
    // Truly idle: notify any straggler (defensive — none by definition here) so the adapter surfaces
    // room:network-warning {reason:"room-evicted"} instead of a silent re-handshake storm (D25), then GC.
    for (const ws of sockets) sendEnvelope(ws, { kind: "evict" });
    await this.ctx.storage.deleteAll();
  }

  /**
   * Handles a `join`: enforces the join-window guard (1008) and controller cap (`full`), binds
   * `{peerId, role}` onto the socket, persists the roster row + a minted reclaim token (output-gate),
   * replies `join-ack` with the star-correct existing peers, and announces `peer-arrived` to that subset.
   *
   * @param ws - The joining socket.
   * @param env - The `join` envelope.
   * @example
   * ```ts
   * this.onJoin(ws, { kind: "join", selfId: "host_root", role: "host" });
   * ```
   */
  private onJoin(ws: WebSocket, env: Extract<ClientEnvelope, { kind: "join" }>): void {
    const sql = this.ctx.storage.sql;
    ensureSchema(sql);
    const att = readAttachment(ws);
    const openedAt = att?.openedAt ?? Date.now();
    // Join-window guard (D24): a socket that already handshook, or a `join` arriving too late, is closed.
    if ((att?.peerId ?? null) !== null || Date.now() - openedAt > defaultConfig.joinWindowMs) {
      ws.close(1008, "join-window");
      return;
    }
    // Cap (controllers only): the host plus up to MAX_CONTROLLERS controllers (D11).
    if (env.role === "controller" && this.countControllers() >= MAX_CONTROLLERS) {
      sendEnvelope(ws, { kind: "full" });
      ws.close(1008, "full");
      return;
    }
    const reclaimToken = crypto.randomUUID();
    const peers = this.starPeersFor(env.role);
    ws.serializeAttachment({ peerId: env.selfId, role: env.role, openedAt });
    insertSession(sql, env.selfId, env.role, reclaimToken, Date.now());
    sendEnvelope(ws, { kind: "join-ack", peers, reclaimToken });
    this.announce(ws, { kind: "peer-arrived", peerId: env.selfId, role: env.role }, env.role);
  }

  /**
   * Handles a `reclaim`: verifies the presented token against SQLite, re-binds the host socket under its
   * (new) `selfId` keeping the same token, replies `reclaim-ack` with the live controllers, and announces
   * the host's return so controllers re-handshake. Rejects an unknown / non-host token with `1008`.
   *
   * @param ws - The reclaiming host socket.
   * @param env - The `reclaim` envelope.
   * @example
   * ```ts
   * this.onReclaim(ws, { kind: "reclaim", selfId: "host_v2", reclaimToken });
   * ```
   */
  private onReclaim(ws: WebSocket, env: Extract<ClientEnvelope, { kind: "reclaim" }>): void {
    const sql = this.ctx.storage.sql;
    ensureSchema(sql);
    const owner = findPeerByReclaimToken(sql, env.reclaimToken);
    if (owner?.role !== "host") {
      sendEnvelope(ws, { kind: "error", code: 1008, message: "reclaim-rejected" });
      ws.close(1008, "reclaim-rejected");
      return;
    }
    const att = readAttachment(ws);
    const openedAt = att?.openedAt ?? Date.now();
    // Re-bind under the new selfId; supersede the stale host row, keeping the same reclaim token.
    ws.serializeAttachment({ peerId: env.selfId, role: "host", openedAt });
    deleteSession(sql, owner.peerId);
    insertSession(sql, env.selfId, "host", env.reclaimToken, Date.now());
    const controllers = listPeers(sql)
      .filter(peer => peer.role === "controller")
      .map(peer => peer.peerId);
    sendEnvelope(ws, { kind: "reclaim-ack", peers: controllers });
    this.announce(ws, { kind: "peer-arrived", peerId: env.selfId, role: "host" }, "host");
  }

  /**
   * Handles a `relay`: delivers `{kind:"relay", from, msg}` to the target socket (looked up by `to`) and
   * persists the in-flight SDP/ICE to the sender's row (output-gate). The `msg` is opaque — the DO never
   * inspects it and there is NO gameplay path (D2/D21).
   *
   * @param ws - The relaying socket.
   * @param env - The `relay` envelope.
   * @example
   * ```ts
   * this.onRelay(ws, { kind: "relay", to: "p_ab12", msg: { kind: "offer", sdp } });
   * ```
   */
  private onRelay(ws: WebSocket, env: Extract<ClientEnvelope, { kind: "relay" }>): void {
    const att = readAttachment(ws);
    if (!att?.peerId) return;
    const target = this.findSocket(env.to);
    if (target) sendEnvelope(target, { kind: "relay", from: att.peerId, msg: env.msg });
    recordRelay(this.ctx.storage.sql, att.peerId, env.msg);
  }

  /**
   * Counts the live controller sockets (for the cap check).
   *
   * @returns The number of attached controllers.
   * @example
   * ```ts
   * if (this.countControllers() >= MAX_CONTROLLERS) sendEnvelope(ws, { kind: "full" });
   * ```
   */
  private countControllers(): number {
    let count = 0;
    for (const ws of this.ctx.getWebSockets()) {
      if (readAttachment(ws)?.role === "controller") count += 1;
    }
    return count;
  }

  /**
   * Collects the ids of every live peer that forms a star edge with `role` (controllers see the host;
   * the host sees all controllers; two controllers never see each other).
   *
   * @param role - The joining peer's role.
   * @returns The star-correct peer ids already present.
   * @example
   * ```ts
   * const peers = this.starPeersFor("controller"); // [hostId]
   * ```
   */
  private starPeersFor(role: Role): PeerId[] {
    const peers: PeerId[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      const att = readAttachment(ws);
      if (!att?.peerId || att.role === null) continue;
      if (isStarPair(role, att.role)) peers.push(att.peerId);
    }
    return peers;
  }

  /**
   * Sends `envelope` to every OTHER socket whose role forms a star edge with `selfRole` — so a
   * controller's arrival/departure reaches only the host (and vice-versa), never another controller.
   *
   * @param self - The originating socket (skipped).
   * @param envelope - The server frame to fan out.
   * @param selfRole - The originating peer's role.
   * @example
   * ```ts
   * this.announce(ws, { kind: "peer-arrived", peerId, role: "controller" }, "controller");
   * ```
   */
  private announce(self: WebSocket, envelope: ServerEnvelope, selfRole: Role): void {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === self) continue;
      const att = readAttachment(ws);
      if (!att?.peerId || att.role === null) continue;
      if (isStarPair(selfRole, att.role)) sendEnvelope(ws, envelope);
    }
  }

  /**
   * Finds the live socket bound to `peerId` (the relay target lookup).
   *
   * @param peerId - The peer id to resolve.
   * @returns The matching socket, or `null`.
   * @example
   * ```ts
   * const target = this.findSocket("p_ab12");
   * ```
   */
  private findSocket(peerId: PeerId): WebSocket | null {
    for (const ws of this.ctx.getWebSockets()) {
      if (readAttachment(ws)?.peerId === peerId) return ws;
    }
    return null;
  }
}
