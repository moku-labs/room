/**
 * @file stage — public type surface (HOST-role facade API).
 * @see README.md
 *
 * Holds ONLY the facade's host-role public surface. Every shared contract type (`Namespace`,
 * `PeerId`, `RosterEntry`) is imported from their owning plugins (`../transport/protocol` for the wire/signaling protocol; `RoomEvents` from `../../config`) —
 * never re-declared. `RoomDescriptor` is session-owned (the room-code/QR/hostToken descriptor) and is
 * imported from `../session/types`. `Cells` is imported from `../sync/types` (the per-namespace
 * cell map type). The facade defines no state, no config, and no `ctx` alias — its
 * methods delegate straight to the four engines (transport, session, intent, sync).
 */

import type { QrMatrix, RoomDescriptor } from "../session/types";
import type { Cells } from "../sync/types";
import type { Namespace, PeerId, RosterEntry } from "../transport/protocol";

/**
 * A mutation recipe applied to one namespaced sync slice on the host. Receives the current cells
 * (key → JSON value) as a readonly snapshot and returns the **next** cells (pure-function style);
 * `sync` diffs old vs. returned-next into an `Op` list (contracts §4.2) and broadcasts a throttled
 * `SyncDeltaFrame` (contracts §2.2, §4.3). Set a cell to `null` to delete it (contracts §4.2).
 * Must remain plain-JSON-serializable (spec/11 §1.7 — no class instances, `Map`, `Set`, functions,
 * `undefined`-holes). Return a new object; do NOT mutate `draft` in place.
 *
 * @param draft - The current cells of the namespace's slice (readonly snapshot).
 * @returns The next cells for this namespace (the result `sync` diffs against the old snapshot).
 * @example
 * ```ts
 * const recipe: MutateRecipe = draft => ({ ...draft, p1: ((draft.p1 as number) ?? 0) + 1 });
 * ```
 */
export type MutateRecipe = (draft: Cells) => Cells;

/**
 * A typed intent handler invoked on the host for each validated controller intent of a given name. The
 * `intent` plugin shape-checks the inbound `IntentFrame` payload (correctness-only — D6, no
 * anti-cheat/HMAC) and de-dups by `cSeq` (contracts §4.3) BEFORE this handler runs, so the handler
 * receives only fresh, well-formed intents. A typical handler calls `mutate(...)` to advance state.
 *
 * @param payload - The validated, plain-JSON intent payload.
 * @param peerId - The controller that sent it (contracts §6 `PeerId`).
 * @example
 * ```ts
 * const onMove: IntentHandler = (payload, peerId) => world.apply(peerId, payload);
 * ```
 */
export type IntentHandler = (payload: unknown, peerId: PeerId) => void;

/**
 * The HOST-role facade API (D5). Every method delegates to a required Wave 1–3 engine; the facade owns no
 * state and runs no resource. This is the single host-shaped surface a game plugin
 * (`depends: [stagePlugin]`) drives — it never reaches into `session`/`sync`/`intent` directly. The
 * mirror phone-role surface is `ControllerApi`.
 *
 * @example
 * ```ts
 * const stage: StageApi = app.stage;
 * const { joinUrl } = stage.createRoom();
 * stage.onIntent("score", (payload, peerId) => stage.mutate("scores", d => { d[peerId] = payload as JsonValue; }));
 * ```
 */
export type StageApi = {
  /**
   * Creates and hosts a new room: delegates to `session.createRoom()`, which mints the 6-char room code
   * (contracts §6.2, `crypto.getRandomValues`) + `hostToken` (contracts §5.1, `crypto.randomUUID()`),
   * joins the §1 signaling rendezvous as the ACTIVE offerer (`passive:false`), and begins accepting
   * controllers up to `MAX_CONTROLLERS` (contracts §6). On a host reload, `session` instead resumes the
   * SAME room (contracts §5.2) — the game calls `createRoom()` once on first boot. Room-code generation is
   * **synchronous** (`crypto.getRandomValues`), so this returns the `RoomDescriptor` **directly — NOT a
   * promise** (the signaling join it kicks off proceeds in the background; the descriptor is ready the
   * instant the code is minted).
   *
   * @returns The `RoomDescriptor` verbatim from `session` — `{ code, joinUrl, qr, hostToken }`: the room
   *   code, the join URL, the `qr` slot (ALWAYS `null` here — `createRoom` is synchronous but QR
   *   generation is async; render the matrix via the async {@link StageApi.qr} accessor), and the
   *   `hostToken` re-entry credential (contracts §5.1, D11).
   * @example
   * ```ts
   * const { code, joinUrl } = app.stage.createRoom();
   * renderJoinCode(code);
   * const qr = await app.stage.qr(); // async — descriptor.qr is null
   * if (qr) renderJoinQr(qr);
   * ```
   */
  createRoom(): RoomDescriptor;

  /**
   * Builds the join-affordance QR matrix for the current room, ASYNCHRONOUSLY: delegates to
   * `session.qr()`. This is the public companion to {@link StageApi.createRoom} — that method returns
   * synchronously (contracts §6.2) and so cannot carry the async-generated matrix on its
   * {@link RoomDescriptor} (`RoomDescriptor.qr` is always `null`); the rendered matrix comes from here.
   * The `qrcode` encoder is lazy-imported HOST-ONLY (it tree-shakes out of the controller bundle,
   * contracts §6.2) and encodes the join URL ONLY — never SDP/ICE. Resolves to `null` when
   * `session`'s `generateQr` config is `false` or no room is open.
   *
   * @returns A promise resolving to the {@link QrMatrix} for the active room's join URL, or `null` when
   *   QR generation is disabled or no room is open.
   * @example
   * ```ts
   * app.stage.createRoom();
   * const qr = await app.stage.qr();
   * if (qr) renderJoinQr(qr); // show on the TV; phones scan to join
   * ```
   */
  qr(): Promise<QrMatrix | null>;

  /**
   * Mutates one authoritative namespaced sync slice on the host: delegates to `sync.mutate(ns, recipe)`.
   * `sync` applies the recipe to the slice's current cells, advances `sSeq` (contracts §4.3), and
   * schedules a throttled (20–30 Hz, contracts §4.3) delta broadcast to every connected controller. This
   * is the ONLY way the host changes shared state — controllers hold a read-only replica (contracts §4)
   * and influence state only by sending intents (see {@link StageApi.onIntent}).
   *
   * @param ns - The target namespace / slice key (contracts §4.1 `Namespace`, e.g. `"scores"`).
   * @param recipe - The return-next recipe applied to the slice's cells (see {@link MutateRecipe}).
   * @returns Nothing.
   * @example
   * ```ts
   * app.stage.mutate("scores", draft => ({ ...draft, p1: ((draft.p1 as number) ?? 0) + 1 }));
   * ```
   */
  mutate(ns: Namespace, recipe: MutateRecipe): void;

  /**
   * Forces an immediate full authoritative snapshot broadcast to all connected controllers: delegates to
   * `sync.broadcast()`. `sync` already broadcasts deltas on its own throttle (contracts §4.3) and sends a
   * fresh `SyncSnapshotFrame` on join / late-join / reconcile (contracts §2.2, §5.3), so an explicit
   * `broadcast()` is only needed when a game wants to flush a snapshot outside the normal cadence (e.g.
   * round transition). Idempotent; safe to over-call.
   *
   * @returns Nothing.
   * @example
   * ```ts
   * app.stage.broadcast(); // re-baseline everyone at round start
   * ```
   */
  broadcast(): void;

  /**
   * Registers a typed host-side handler for a named controller intent: delegates to `intent.onIntent`,
   * adapting the engine's `(payload, meta)` callback to this facade's simpler `(payload, peerId)` surface
   * (it unwraps `meta.peerId` — `intent`'s `IntentMeta` is `{ peerId; cSeq }`). `intent` validates each
   * inbound `IntentFrame` payload by a correctness-only typed shape-check (D6 — no anti-cheat/rate-limit/
   * HMAC) and drops any `cSeq <= lastApplied[peerId]` (contracts §4.3 idempotence) before invoking the
   * handler, so the handler sees only fresh, well-formed intents. The handler typically calls
   * {@link StageApi.mutate} to advance authoritative state.
   *
   * @param name - The registered intent name (the §2.2 `IntentFrame.name` discriminator).
   * @param handler - The host-side callback for validated intents, invoked with `(payload, peerId)` (see
   *   {@link IntentHandler}).
   * @returns An unsubscribe function that removes the handler.
   * @example
   * ```ts
   * const off = app.stage.onIntent("move", (payload, peerId) => {
   *   app.stage.mutate("players", d => { d[peerId] = payload as JsonValue; });
   * });
   * ```
   */
  onIntent(name: string, handler: IntentHandler): () => void;

  /**
   * Returns a snapshot of the current connected-controller roster: delegates to `session.roster()`.
   * Read-only; the array reflects the §6 roster at call time (entries are added on `room:peer-joined` and
   * removed on `room:peer-left`/heartbeat-dead, contracts §2.4/§3). Use it to render the lobby and to size
   * game logic to the live player count (≤ `MAX_CONTROLLERS`).
   *
   * @returns The current roster entries (contracts §6.1 `RosterEntry`).
   * @example
   * ```ts
   * const players = app.stage.roster();
   * renderLobby(players.map(p => p.name ?? p.id));
   * ```
   */
  roster(): readonly RosterEntry[];
};
