/**
 * @file Public + internal type surface for `sessionPlugin`. Shared cross-cutting types
 * (`PeerId`, `RosterEntry`, `RoomEvents`, `Frame`, the recovery frames, `IntentFrame`, `Snapshot`,
 * `MAX_CONTROLLERS`, `ROOM_CODE_LENGTH`) are DEFINED ONCE in `00-contracts.md` — physically in
 * `../../contracts` (D16) — and imported here with `import type`; they are NEVER re-declared.
 * Handle/timer types (`TimerHandle`, `PersistHandle`) are opaque internals declared in
 * `recovery/types.ts`.
 * @see README.md
 *
 * `sessionPlugin` is wired in `index.ts` where `@moku-labs/web` infers `ctx` for `createPlugin` (D1 —
 * `PluginContext` is not exported by web, so it is never imported). The extracted `api`/`handlers`/
 * `recovery` modules therefore take the destructured {@link SessionDeps} bundle (per-app `state` +
 * `config` + narrowed `emit` closures + a `requireTransport` closure) the harness builds inline — never
 * a `ctx` value/type (mirrors `transport`'s destructured factory contract, D14).
 */

import type { IntentFrame, PeerId, RoomEvents, RosterEntry, Snapshot } from "../../contracts";
import type { transportPlugin } from "../transport";
import type { TransportApi } from "../transport/types";
import type { PersistHandleInternal, TimerHandle } from "./recovery/types";

// Re-export the contract types `index.ts` + sibling barrels reach through this plugin's surface, so they
// import from ONE place WITHOUT re-declaring them (D16 — defined once in `../../contracts`, imported here).
export type {
  Frame,
  IntentFrame,
  PeerId,
  RoomEvents,
  RosterEntry,
  Snapshot
} from "../../contracts";

/**
 * Configuration for `sessionPlugin`. All fields have defaults; a consumer overrides any subset via
 * `createApp({ pluginConfigs: { session: { ... } } })` (shallow merge, spec/06 §2). The defaults encode
 * the D11 / contracts §5 verified constants — change them only with a matching test update.
 *
 * @example
 * ```ts
 * // Shorten the reconnect window and disable QR for a headless test harness.
 * createApp({
 *   plugins: roomPlugins.stage,
 *   pluginConfigs: { session: { reconnectTimeoutMs: 4000, generateQr: false } }
 * });
 * ```
 */
export type SessionConfig = {
  /**
   * Origin used to build the controller join URL embedded in the QR (`${joinUrlBase}?room=CODE`).
   * Empty string means "use the current document origin at runtime" — the host resolves
   * `location.origin` lazily when it is unset, keeping `state.ts` DOM-free.
   */
  readonly joinUrlBase: string;
  /**
   * Whether `createRoom()` also produces QR matrix data. `false` skips QR work entirely for headless
   * test/integration runs (the `inMemory` adapter has no camera path). Default `true`.
   */
  readonly generateQr: boolean;
  /**
   * Maximum simultaneous controllers (excludes the host). Defaults to `MAX_CONTROLLERS` (8) from
   * contracts §6.1. Lowering it is supported; raising it above 8 is not recommended (the 8-cap is the
   * verified TV-class fan-out ceiling, D11) but is not hard-blocked.
   */
  readonly maxControllers: number;
  /**
   * Debounce interval (ms) for the durable IndexedDB host-snapshot write during normal play
   * (contracts §5.1). Default `500`.
   */
  readonly snapshotDebounceMs: number;
  /**
   * Reconnect window (ms) a controller waits for the reloaded host to re-appear before surfacing
   * failure UX / degrading to "rescan QR" (contracts §5.4). Default `10_000`.
   */
  readonly reconnectTimeoutMs: number;
  /**
   * Maximum number of intents a controller buffers while the host is absent (§5.4 lossy cap). Oldest
   * are dropped first (ring buffer) once exceeded. Default `256`.
   */
  readonly intentBufferMax: number;
  /**
   * Maximum age (ms) of a buffered intent before it is discarded on flush — lossy for high-frequency
   * analog intents, acceptable for the v1 party-game target (§5.4). Default `8000`.
   */
  readonly intentBufferMaxAgeMs: number;
  /**
   * localStorage key prefix for the phone-persisted `reconnectToken` (§6.1) and the host re-entry
   * record. The room code is appended so multiple rooms on one device never collide. Default
   * `"moku.room"`.
   */
  readonly storageKeyPrefix: string;
  /**
   * Number of characters in a minted room code. Default `ROOM_CODE_LENGTH` (6) from contracts §6.2.
   * **`serverSignaling` deployments SHOULD set `8`** (~57 bits) to resist room-code enumeration of
   * the public DO endpoint (D24, Cycle 2). `lifecycle/code.ts` reads this; the `ROOM_CODE_LENGTH`
   * const is unchanged. Optional + defaulted — additive, non-breaking for existing consumers.
   */
  readonly codeLength?: number;
};

/** This device's role for the current room. `"none"` until `createRoom`/`joinRoom` is called. */
export type Role = "host" | "controller" | "none";

/** Coarse phase of the host-reload recovery state machine (drives controller reconnect UX). */
export type RecoveryPhase =
  | "stable" // host present, normal play
  | "host-absent" // host channel lost; controller buffering intents, waiting for re-entry
  | "verifying" // re-entry detected; hostToken handshake in flight
  | "reconciling" // token verified; flushing buffer + awaiting fresh snapshot
  | "degraded"; // reconnect timed out (iOS -> "rescan QR"); session unrecoverable here

/** One timestamped buffered intent (§5.3). `intent` is the §2 `IntentFrame`; `ts` is capture epoch-ms. Plain-JSON. */
export type BufferedIntent = { readonly intent: IntentFrame; readonly ts: number };

/**
 * The live recovery sub-state (§5). The `phase` + `buffer` + `reconnectDeadline` are plain-JSON; the
 * `timer`/`persistHandle` fields are runtime-only resources (NEVER persisted, NEVER sent over §2) and are
 * `null` when idle. Lives inside `ctx.state`; `onStop` reaches it via the module-level
 * `teardownRegistry: WeakMap<object, SessionState>` keyed by `ctx.global` (D14), never a singleton.
 */
export type RecoverySubState = {
  /** Current recovery phase (controller-relevant; on the host it stays `"stable"` and flips to drive `room:host-reconnecting`). */
  phase: RecoveryPhase;
  /**
   * Controller-side intent buffer captured while `phase !== "stable"` — timestamped per §5.3. A ring
   * buffer capped at `config.intentBufferMax`; entries older than `config.intentBufferMaxAgeMs` are
   * dropped on flush.
   */
  buffer: BufferedIntent[];
  /** Epoch-ms deadline (`Date.now() + reconnectTimeoutMs`) after which a controller degrades; `0` when not counting down. */
  reconnectDeadline: number;
  /** Runtime-only reconnect-timeout handle. `null` when idle. NOT persisted, NOT serialized. */
  timer: TimerHandle | null;
  /** Runtime-only handle to the debounced persistence driver (IndexedDB + visibilitychange wiring). `null` until armed. */
  persistHandle: PersistHandleInternal | null;
};

/**
 * Internal mutable state for `sessionPlugin` (`ctx.state`, the only mutable surface — spec/08 §6). Every
 * field is plain-JSON-serializable EXCEPT the noted handle/timer fields inside `recovery`, which are
 * runtime-only resources never sent over §2 nor persisted.
 *
 * @example
 * ```ts
 * // Host, room "G7K2QF", two controllers connected, stable.
 * {
 *   role: "host",
 *   selfId: "a1b2c3d4",
 *   roomCode: "G7K2QF",
 *   hostToken: "f81d4fae-7dec-11d0-a765-00a0c91e6bf6",
 *   roster: { "p-1": { id: "p-1", reconnectToken: "rt-1", name: "Ann", joinedAt: 1718600000000 } },
 *   sSeqAtSnapshot: 42,
 *   recovery: { phase: "stable", buffer: [], reconnectDeadline: 0, timer: null, persistHandle: null }
 * }
 * ```
 */
export type SessionState = {
  /** This device's role. Set by `createRoom` (-> `"host"`) / `joinRoom` (-> `"controller"`). Starts `"none"`. */
  role: Role;
  /** This device's stable signaling/wire id (§6, `PeerId`). Minted on first `createRoom`/`joinRoom`. Empty until then. */
  selfId: PeerId;
  /** The active 6-char room code (§6.2), or `""` when not in a room. Set by `createRoom`/`joinRoom`, cleared by `leave`. */
  roomCode: string;
  /**
   * The host re-entry credential (`crypto.randomUUID()`, §5.1). On the HOST minted at `createRoom` and
   * persisted; on a CONTROLLER it is the token last received from the host (stored to verify on re-entry).
   * `""` until known.
   */
  hostToken: string;
  /**
   * The roster — controller `PeerId` -> `RosterEntry` (§6.1). HOST-authoritative; on a controller it
   * mirrors what the host broadcast (read-only there). Plain map of plain-JSON entries. Starts `{}`.
   */
  roster: Record<PeerId, RosterEntry>;
  /**
   * The host sequence number (`sSeq`, §4.3) captured alongside the most recent persisted snapshot, so a
   * reloaded host can re-baseline controllers without consulting `sync`'s state. `0` until the first persist.
   */
  sSeqAtSnapshot: number;
  /** Live recovery sub-state (§5). See {@link RecoverySubState}. */
  recovery: RecoverySubState;
  /**
   * Runtime-only controller-join handle: resolves the in-flight `joinRoom` promise when the host channel
   * opens. NEVER serialized (a peer of `recovery.timer`/`persistHandle`); optional/absent until a join is
   * in flight, accessed only inside `sessionPlugin`, never across the wire. Kept at the state root for
   * access convenience (§5.2).
   */
  _pendingJoinResolve?: ((result: JoinResult) => void) | null;
  /** Runtime-only: rejects the in-flight `joinRoom` promise (paired with {@link SessionState._pendingJoinResolve}). */
  _pendingJoinReject?: ((reason: unknown) => void) | null;
  /** Runtime-only: the resolved host `PeerId` on a controller (the single star hub); `null`/absent until known. */
  _hostId?: string | null;
  /** Runtime-only: the in-flight `joinRoom` unreachable-timeout handle. */
  _joinTimeout?: ReturnType<typeof setTimeout> | null;
  /** Runtime-only (host): the persisted re-entry record retained for re-broadcast on controller reconnect. */
  _reentryRecord?: HostReentryRecord | null;
};

/**
 * The persisted host re-entry record written to IndexedDB (debounced) and localStorage (sync, on
 * `visibilitychange`). Plain-JSON (§5.1). Read back verbatim on reload to drive re-entry. This is the
 * ONLY thing `sessionPlugin` persists; the authoritative `snapshot` is produced by `sync` and handed to
 * `session.persistSnapshot()` — `session` stores it opaquely.
 */
export type HostReentryRecord = {
  /** The room code to rejoin (§5.2). */
  readonly roomCode: string;
  /** The host token to present to controllers for peer-side verification (§5.1/§5.2). */
  readonly hostToken: string;
  /** The authoritative `Snapshot` (§4.1) to re-baseline controllers after re-entry. */
  readonly snapshot: Snapshot;
  /** The `sSeq` (§4.3) the snapshot represents — stamped into the re-entry `RecoveryWelcomeFrame`. */
  readonly sSeq: number;
  /** Epoch-ms the record was written (staleness check on reload). */
  readonly savedAt: number;
  /**
   * (`serverSignaling` deployments only) The DO-issued host re-entry token captured from
   * `transport.reclaimToken()` after `connect()`. Replayed via `ConnectOpts.reclaimToken` on host reload
   * so the warm Durable Object re-binds this host instead of opening a fresh room (§1.3/§5.1, D25).
   * Absent on `publicRendezvous`/`inMemory` deployments (no DO ⇒ no token).
   */
  readonly reclaimToken?: string;
};

/** Lightweight QR payload: the module size + a row-major boolean matrix the consumer renders however it likes. */
export type QrMatrix = {
  /** Number of modules per side (the QR "version" expressed as a pixel grid edge). */
  readonly size: number;
  /** Row-major dark/light modules (`true` = dark). Length is `size * size`. */
  readonly modules: readonly boolean[];
};

/** Result of `createRoom` — everything the TV needs to display the join affordance. Plain-JSON-friendly. */
export type RoomDescriptor = {
  /** The 6-char room code (§6.2). */
  readonly code: string;
  /** The full controller join URL (`${joinUrlBase}?room=CODE`) the QR encodes (§6.2). */
  readonly joinUrl: string;
  /**
   * Always `null` on the descriptor: `createRoom()` returns SYNCHRONOUSLY (§6.2) but QR generation is
   * ASYNC (the `qrcode` encoder is lazy-imported host-only). Obtain the rendered matrix from the async
   * {@link SessionApi.qr} accessor (or the host facade's `stage.qr()`) — it encodes the code/URL ONLY,
   * never SDP/ICE (§6.2). Retained on the descriptor for shape stability.
   */
  readonly qr: QrMatrix | null;
  /** The client-side host-reclaim credential (`crypto.randomUUID()`, §5.1, D11) — minted on `createRoom`, presented on host re-entry for peer-side verification. */
  readonly hostToken: string;
};

/** Discriminated result of `joinRoom`/`rejoin`. Fullness/not-found are API results, NOT events (§6.2). */
export type JoinResult =
  | { readonly ok: true; readonly selfId: PeerId }
  | { readonly ok: false; readonly reason: "full" | "not-found" | "unreachable" };

/** This device's identity surface. */
export type SelfInfo = {
  /** Stable id (§6). */
  readonly selfId: PeerId;
  /** Current role. */
  readonly role: Role;
  /** Active room code, or `""`. */
  readonly roomCode: string;
};

/**
 * The narrowed `emit` closures `sessionPlugin` binds to `ctx.emit` for its THREE owned `room:*` events
 * (§3). The wiring harness (`index.ts`) builds these inline so the extracted modules never touch `ctx`
 * (mirrors `transport`'s `emitWarning` closure). No wire/DataChannel traffic ever flows through these —
 * only the coarse lifecycle events do.
 */
export type SessionEmit = {
  /** Emits `room:peer-joined` — a controller's channel reached `connected` and joined the roster. */
  peerJoined: (payload: RoomEvents["room:peer-joined"]) => void;
  /** Emits `room:peer-left` — a controller left or was declared dead and removed from the roster. */
  peerLeft: (payload: RoomEvents["room:peer-left"]) => void;
  /** Emits `room:host-reconnecting` — the host tab reloaded and client-side recovery is in flight. */
  hostReconnecting: (payload: RoomEvents["room:host-reconnecting"]) => void;
};

/**
 * The minimal injected logger surface `sessionPlugin` reads off `ctx.log` (bound by `@moku-labs/web`,
 * D1). Only `warn` is used — for the defensive star-topology rejection (§6), which logs but emits no
 * event. The real `ctx.log` is structurally assignable to this narrow shape.
 */
export type SessionLog = {
  /** Logs a warning message (the star-topology rejection path — no event). */
  warn: (message: string) => void;
};

/**
 * The destructured per-app pieces every extracted `session` module receives (D14). Built inline by the
 * `index.ts` wiring harness from the inferred `ctx` (`@moku-labs/web` infers `createPlugin`'s context;
 * `PluginContext` is NOT imported — it is not exported by web, D1). Carries the per-app mutable `state`,
 * the frozen `config`, the narrowed {@link SessionEmit} closures, and a `requireTransport` closure over
 * `ctx.require(transportPlugin)` — so NO module closes over a module-level singleton. UA/DOM gating for
 * the iOS degrade + storage guards (§5.4) reads `navigator`/`window` behind DOM guards INSIDE
 * `recovery/*` at build time (deferred per the Skeleton Revisit notes), not through this bundle.
 *
 * @example
 * ```ts
 * // index.ts wiring:
 * api: (ctx) =>
 *   createSessionApi({
 *     state: ctx.state,
 *     config: ctx.config,
 *     emit: {
 *       peerJoined: (p) => ctx.emit("room:peer-joined", p),
 *       peerLeft: (p) => ctx.emit("room:peer-left", p),
 *       hostReconnecting: (p) => ctx.emit("room:host-reconnecting", p)
 *     },
 *     requireTransport: () => ctx.require(transportPlugin)
 *   });
 * ```
 */
export type SessionDeps = {
  /** This app's mutable session state (the only mutable surface — spec/08 §6). */
  readonly state: SessionState;
  /** This app's frozen, resolved config. */
  readonly config: Readonly<SessionConfig>;
  /** The narrowed `emit` closures for the three owned `room:*` events (§3). */
  readonly emit: SessionEmit;
  /** The injected `ctx.log` warning surface (the defensive star-topology rejection logs here). */
  readonly log: SessionLog;
  /** Resolves the hard `transport` dependency the canonical way (`ctx.require(transportPlugin)`). */
  readonly requireTransport: () => TransportApi;
};

/**
 * The STRUCTURAL slice of the inferred plugin `ctx` the `makeSessionDeps` builder reads — deliberately
 * NOT `PluginContext` (web does not export it, D1). The rich `ctx` `@moku-labs/web` infers for
 * `createPlugin` is structurally assignable to this, so the builder lives in `api.ts` while the `index.ts`
 * harness stays a tiny `createSessionApi(makeSessionDeps(ctx))` wiring (≤30 lines). Carries only the
 * members the builder touches: `state`, `config`, the typed `emit` overload for the three owned `room:*`
 * events, and `require` resolving `transportPlugin` to its {@link TransportApi}.
 */
export type SessionContextShape = {
  /** Per-app mutable session state. */
  readonly state: SessionState;
  /** Per-app frozen, resolved config. */
  readonly config: Readonly<SessionConfig>;
  /** The kernel's typed `emit`, narrowed to the three owned `room:*` events. */
  readonly emit: {
    (name: "room:peer-joined", payload: RoomEvents["room:peer-joined"]): void;
    (name: "room:peer-left", payload: RoomEvents["room:peer-left"]): void;
    (name: "room:host-reconnecting", payload: RoomEvents["room:host-reconnecting"]): void;
  };
  /** The kernel's injected logger (`ctx.log`), narrowed to the `warn` surface this plugin uses. */
  readonly log: SessionLog;
  /** Resolves a dependency plugin instance to its public API (here `transportPlugin` -> `TransportApi`). */
  readonly require: (plugin: typeof transportPlugin) => TransportApi;
};

/**
 * Public API of `sessionPlugin`. Star-topology + cap enforcement live behind these methods (§6). No
 * wire/DataChannel traffic flows through `emit` — recovery frames + roster ride `transport`'s `Wire`;
 * only the coarse `room:*` lifecycle events use `ctx.emit`.
 */
export type SessionApi = {
  /**
   * HOST entry point. Mints `selfId` + a 6-char room code (`crypto.getRandomValues`, §6.2) + the
   * `hostToken` (`crypto.randomUUID()`, §5.1), tells `transport` to join the signaling room as the active
   * star hub (`passive:false`, §1.1), arms host-snapshot persistence (§5.1), and returns the room
   * descriptor SYNCHRONOUSLY (room-code generation is synchronous — no `Promise`).
   *
   * @throws {Error} If this device is already in a room (call `leave()` first).
   * @example
   * ```ts
   * const { code, joinUrl, qr, hostToken } = app.session.createRoom();
   * renderQr(qr); // show on the TV; phones scan to join
   * persistHostToken(hostToken); // client-side reclaim credential for host re-entry (§5.1)
   * ```
   */
  createRoom: () => RoomDescriptor;

  /**
   * Builds the join-affordance QR matrix for the CURRENT room, ASYNCHRONOUSLY. This is the public
   * companion to {@link SessionApi.createRoom}: that method returns synchronously (§6.2) and therefore
   * cannot carry the async-generated matrix on its {@link RoomDescriptor} (`RoomDescriptor.qr` is always
   * `null`) — the rendered matrix comes from here instead. The `qrcode` encoder is lazy-imported
   * HOST-ONLY so it tree-shakes out of the `<5 KB` controller bundle (§6.2). The encoded payload is the
   * join URL ONLY — never SDP/ICE (§6.2). Resolves to `null` when `config.generateQr` is `false` (the
   * headless / controller path) or when no room is active.
   *
   * @returns A promise resolving to the {@link QrMatrix} for the active room's join URL, or `null` when
   *   QR generation is disabled (`config.generateQr === false`) or no room is open.
   * @example
   * ```ts
   * app.session.createRoom();           // sync — descriptor.qr is null
   * const qr = await app.session.qr();  // async — the rendered matrix (or null when disabled)
   * if (qr) renderQr(qr);               // show on the TV; phones scan to join
   * ```
   */
  qr: () => Promise<QrMatrix | null>;

  /**
   * CONTROLLER entry point. Loads/creates the phone-persisted `reconnectToken` (§6.1), mints/reuses
   * `selfId`, and tells `transport` to join the signaling room as a passive answerer (`passive:true`,
   * §1.1). Resolves once the DataChannel to the host is `connected`. The `passive:true` flag is set
   * INTERNALLY (§1.1) — callers pass `code` only.
   *
   * @param code - The 6-char room code from the scanned QR / manual entry (§6.2).
   * @returns `{ ok: true, selfId }` on success, or `{ ok: false, reason }` for `"full"` | `"not-found"` | `"unreachable"`.
   * @example
   * ```ts
   * const res = await app.session.joinRoom("G7K2QF");
   * if (!res.ok && res.reason === "full") showFullRoomScreen();
   * ```
   */
  joinRoom: (code: string) => Promise<JoinResult>;

  /**
   * Leaves the current room: closes this device's transport channel(s), clears the roster (host) or
   * detaches (controller), disarms recovery timers/persistence, and resets `role`/`roomCode` to idle.
   * Idempotent — a no-op when not in a room.
   *
   * @returns Resolves when transport teardown for this device completes.
   * @example
   * ```ts
   * await app.session.leave();
   * ```
   */
  leave: () => Promise<void>;

  /**
   * CONTROLLER re-entry helper for the iOS "rescan QR" degradation path (§5.4): re-runs the join handshake
   * against the stored `roomCode` after a degrade, re-using the phone-persisted `reconnectToken` so the
   * controller re-binds to the same roster slot. Non-iOS controllers normally auto-rejoin without this.
   *
   * @returns Same shape as {@link SessionApi.joinRoom}.
   * @throws {Error} If there is no prior room to rejoin (no stored `reconnectToken`).
   * @example
   * ```ts
   * if (app.session.recoveryPhase() === "degraded") await app.session.rejoin();
   * ```
   */
  rejoin: () => Promise<JoinResult>;

  /**
   * Reads the current roster snapshot (§6.1). On the host this is authoritative; on a controller it
   * mirrors the host's last broadcast. Returns a defensive copy so callers cannot mutate internal state.
   *
   * @returns The connected controllers, ordered by `joinedAt` ascending.
   * @example
   * ```ts
   * for (const p of app.session.roster()) renderSeat(p.id, p.name);
   * ```
   */
  roster: () => readonly RosterEntry[];

  /**
   * Reads this device's stable id (§6) — the `isHost`/`getRoomCode`-style identity surface. Fields are
   * `""`/`"none"` before `createRoom`/`joinRoom`.
   *
   * @returns `{ selfId, role, roomCode }` for the current session.
   * @example
   * ```ts
   * const { role } = app.session.self();
   * ```
   */
  self: () => SelfInfo;

  /**
   * Reads the authoritative HOST peer id (§6 star topology). On the host this equals `self().selfId`; on
   * a controller it is the single hub peer every `IntentFrame` targets (the controller→host edge). It is
   * `""` before the channel to the host is established. `intentPlugin` uses it to address the host.
   *
   * @returns The host's stable {@link PeerId} (the star hub), or `""` when not yet connected.
   * @example
   * ```ts
   * wire.send(app.session.hostId(), intentFrame);
   * ```
   */
  hostId: () => PeerId;

  /**
   * HOST-ONLY. Hands the authoritative `Snapshot` + its `sSeq` to be persisted for host-reload recovery
   * (§5.1). `session` stores it opaquely in the debounced IndexedDB write and the synchronous
   * `visibilitychange` localStorage write — it never inspects the payload. Called by `sync` whenever it
   * commits a broadcast tick (the integration seam between the two plugins). No-op on a controller.
   *
   * @param snapshot - The complete authoritative state (§4.1).
   * @param sSeq - The host sequence this snapshot represents (§4.3).
   * @example
   * ```ts
   * app.session.persistSnapshot(snapshot, sSeq);
   * ```
   */
  persistSnapshot: (snapshot: Snapshot, sSeq: number) => void;

  /**
   * Returns the current recovery phase (§5) so a facade/consumer can render reconnect UX without
   * subscribing to internals. Pairs with the `room:host-reconnecting` event for the host-side signal.
   *
   * @returns The live recovery phase.
   * @example
   * ```ts
   * if (app.session.recoveryPhase() !== "stable") showReconnectingOverlay();
   * ```
   */
  recoveryPhase: () => RecoveryPhase;
};
