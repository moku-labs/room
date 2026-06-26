/**
 * @file Sync plugin types — config, state, the public API, and the internal `SyncEngine` contract.
 * @see README.md
 *
 * Holds ONLY sync's internal types. Every shared contract type (`Snapshot`, `Op`, `JsonValue`,
 * `Namespace`, `PeerId`, `Frame`) is imported from their owning plugins (`../transport/protocol` for the wire/signaling protocol; `RoomEvents` from `../../config`) —
 * never re-declared or re-exported here. `Config` and `Api` are `type` aliases (NOT `interface`)
 * so they satisfy `Record<string, unknown>`.
 */
import type { Frame, JsonValue, Namespace, PeerId, Snapshot } from "../transport/protocol";

/**
 * One namespace's cell map — the unit `read`/`mutate`/`subscribe` operate on. Every leaf is a
 * {@link JsonValue} (contracts section 4.1) so it survives codec round-trips, transport JSON, and
 * `localStorage`/IndexedDB persistence. Re-exported `Snapshot`/`Op` cells are this shape per namespace.
 */
export type Cells = { readonly [key: string]: JsonValue };

/**
 * Configuration for `syncPlugin`. Flat by Moku convention (spec/11 section 2.6) — shallow-merged and
 * frozen at `createApp`. Defaults target the verified couch profile: TV-class host CPU, an O(N) fan-out
 * to up to 8 controllers, and a 60 Hz game loop decoupled from a 20-30 Hz broadcast.
 *
 * @example
 * ```ts
 * const cfg: Partial<Config> = { broadcastHz: 20 };
 * ```
 */
export type Config = {
  /**
   * Authoritative broadcast rate, in Hz. The throttle loop coalesces all mutates within a tick into one
   * `SyncDeltaFrame` and broadcasts at this cadence — independent of the 60 Hz game loop. Verified safe
   * band is 20-30 Hz on the Bravia-7-class host with the 8-controller cap (contracts section 4.3). Clamped
   * to `[5, 60]` in `onInit`. Default `30`.
   */
  readonly broadcastHz: number;
  /**
   * If `true`, the host coalesces a no-change tick into NO broadcast (no `SyncDeltaFrame` is sent when
   * zero namespaces are dirty). Saves the O(N) fan-out on idle frames. Default `true`. Set `false` only
   * for a heartbeat-style "always send a tick" diagnostic.
   */
  readonly skipEmptyDeltas: boolean;
  /**
   * Maximum number of `Op` cells the host batches into a single `SyncDeltaFrame` before it forces an
   * extra frame in the same tick. Bounds per-frame JSON size so a burst stays under the transport chunk
   * threshold (~14 KiB, contracts section 2.3) without relying on chunking. `0` disables the cap (rely on
   * transport chunking). Default `512`.
   */
  readonly maxOpsPerDelta: number;
  /**
   * When a controller detects a sequence gap (`incoming.sSeq > local.sSeq + 1`, contracts section 4.3), it
   * marks itself stale and requests a fresh snapshot. If `true`, the engine surfaces a host-side hook
   * (`onResyncRequest`) so the host can `send` a snapshot to that peer; if `false`, the controller waits
   * for the next host snapshot. Default `true`.
   */
  readonly resyncOnGap: boolean;
};

/**
 * Mutable `syncPlugin` engine state. Created by `createSyncState` (state.ts). NOT exposed raw on the API
 * (spec/11 section 2.4) — the API returns closures/readonly views over it. The same shape serves host
 * (authoritative) and controller (replica) — role is behavioral, not structural (D4/D5). Every serialized
 * field is plain-JSON; `throttleHandle` and `engine` are the two NON-serialized runtime cells.
 *
 * @example
 * ```ts
 * const state: State = {
 *   snapshot: {}, dirty: {}, sSeq: 0, ready: false,
 *   stale: false, broadcasting: false, throttleHandle: null, engine: null
 * };
 * ```
 */
export type State = {
  /**
   * The current `Snapshot` (contracts section 4.1). On the host it is the authoritative state; on a
   * controller it is the read-only replica. Every cell is a `JsonValue`. Mutated only via `mutate` (host)
   * or `applyFrame` (controller).
   */
  snapshot: Snapshot;
  /**
   * Set of namespace keys with unbroadcast writes since the last delta tick — the per-namespace
   * dirty-flag (D4; contracts section 4.3). Plain object used as a set (`{ [ns]: true }`) to stay
   * plain-JSON; cleared each tick after the delta is encoded. Empty on a controller (it never mutates).
   */
  dirty: { readonly [ns: Namespace]: true };
  /**
   * The host sequence number (`sSeq`, contracts section 4.3). Host: incremented per non-empty broadcast
   * tick; stamps each delta/snapshot frame. Controller: the `sSeq` of the last successfully-applied frame
   * — the baseline gap-detection compares against.
   */
  sSeq: number;
  /**
   * `true` once the FIRST snapshot has been applied (host: after `registerSlice` + first export;
   * controller: after the first inbound `sync-snap`). Gates `room:sync-ready` (emitted exactly once on the
   * transition `false -> true`) and `read`/`subscribe` correctness (contracts section 3.1, section 4).
   */
  ready: boolean;
  /**
   * `true` on a controller that detected a sequence gap and is awaiting a fresh snapshot (contracts
   * section 4.3). While stale, inbound deltas are ignored (they would apply out of order); the next
   * `sync-snap` clears it. Always `false` on the host.
   */
  stale: boolean;
  /**
   * Whether the engine is in active host-broadcast mode. Set `true` by `startBroadcast` (host `onStart`),
   * `false` by `stopBroadcast`/`onStop`. Gates the throttle timer. A controller leaves this `false` — it
   * never broadcasts. NON-serialized runtime flag (not part of the persisted snapshot).
   */
  broadcasting: boolean;
  /**
   * The live throttle-loop timer handle (`setInterval` id, or a `requestAnimationFrame` id). A
   * NON-serialized runtime resource — never persisted, never part of the `Snapshot`. Held HERE in
   * `ctx.state` (per-app) rather than a module-level variable because Room composes MULTIPLE app instances
   * in one process. `startBroadcast` assigns it; `stopBroadcast`/`onStop` clears it and sets it back to
   * `null`. `null` whenever the loop is not scheduled (always on a controller). `onStop` reaches it via
   * the per-instance `teardownRegistry` WeakMap keyed by `ctx.global` (D14).
   */
  throttleHandle: ReturnType<typeof setInterval> | number | null;
  /**
   * The ONE per-app `SyncEngine`, built exactly once in `api` and shared by every other lifecycle method
   * for THIS app. A NON-serialized runtime cell — a live object reference, never persisted, `null` until
   * `api` builds it. Held HERE (not a module-level `let`) for the same per-app reason as `throttleHandle`.
   * Building once and sharing is mandatory for correctness: the engine owns the per-namespace `subscribe`
   * callback registry (a closure `Map`), so consumer subscriptions and inbound-frame application MUST hit
   * the SAME engine or callbacks never fire. `onStop` reaches it via the `teardownRegistry` entry.
   */
  engine: SyncEngine | null;
};

/**
 * The `syncPlugin` public API surface (role-agnostic, D4/D5). Returned by `createSyncApi` (api.ts) as a
 * thin delegation over the one per-app `SyncEngine`. Host methods write/broadcast authoritative state;
 * controller methods read/apply the replica; the recovery methods are the persistence seam `sessionPlugin`
 * calls (contracts section 5). Frame I/O rides `transport` (contracts section 2) — nothing here uses Moku
 * `emit` except the engine's single `room:sync-ready`.
 *
 * @example
 * ```ts
 * app.sync.registerSlice("scores", { p1: 0, p2: 0 });
 * const off = app.sync.subscribe("scores", cells => render(cells));
 * ```
 */
export type Api = {
  /**
   * Registers a namespaced typed slice with its initial value (host; D4). Call ONCE per namespace before
   * the first broadcast. Idempotent re-register with the same initial is a no-op; a different initial
   * throws. The first `registerSlice` makes the host's snapshot readable.
   *
   * @param ns - The namespace key (contracts section 4.1 `Namespace`).
   * @param initial - The slice's initial plain-JSON cells (every leaf a `JsonValue`, contracts section 4.1).
   * @throws {Error} If `ns` is re-registered with a different initial value.
   * @example
   * ```ts
   * sync.registerSlice("scores", { p1: 0, p2: 0 });
   * sync.registerSlice("round", { n: 1, phase: "lobby" });
   * ```
   */
  registerSlice(ns: Namespace, initial: Cells): void;

  /**
   * Mutates a registered slice (host only). `recipe` receives a draft of the namespace's cells and returns
   * the next cells (pure-function style); the engine diffs old vs. next to compute the `Op[]`. Marks the
   * namespace dirty; does NOT broadcast synchronously — the next throttle tick coalesces and broadcasts
   * (contracts section 4.3). Throws if `ns` was never registered.
   *
   * @param ns - The target namespace (must be registered).
   * @param recipe - Pure function `(draft) => next` returning the namespace's next plain-JSON cells.
   * @throws {Error} If `ns` was never registered.
   * @example
   * ```ts
   * sync.mutate("scores", (s) => ({ ...s, p1: (s.p1 as number) + 10 }));
   * ```
   */
  mutate(ns: Namespace, recipe: (draft: Cells) => Cells): void;

  /**
   * Forces an immediate authoritative broadcast (host only), bypassing the next throttle tick. With
   * `peerId`, sends a full `SyncSnapshotFrame` to that single peer (late-join/reconcile, contracts
   * section 5.3); without it, broadcasts a `SyncDeltaFrame` of all dirty namespaces to every controller.
   * No-op when nothing is dirty and `skipEmptyDeltas` is `true`.
   *
   * @param peerId - Optional single recipient for a full snapshot (contracts section 6); omit to broadcast
   *   a delta to every controller.
   * @example
   * ```ts
   * sync.broadcast();           // flush dirty deltas to everyone now
   * sync.broadcast(newPeerId);  // send a full baseline snapshot to one late-joiner
   * ```
   */
  broadcast(peerId?: PeerId): void;

  /**
   * Registers the host-side resync handler fired when a controller reports a sequence gap (only when
   * `config.resyncOnGap` is `true`). The handler typically calls `broadcast(peerId)` to re-baseline that
   * one peer (contracts section 4.3, section 5.3).
   *
   * @param handler - Invoked with the lagging controller's `peerId`.
   * @returns An unsubscribe function.
   * @example
   * ```ts
   * const off = sync.onResyncRequest((peerId) => sync.broadcast(peerId));
   * ```
   */
  onResyncRequest(handler: (peerId: PeerId) => void): () => void;

  /**
   * Reads the current replica value of a namespace (controller; also valid host-side as a readonly view).
   * Returns a structurally-frozen, plain-JSON copy of the namespace's cells — never a live reference into
   * engine state (spec/11 section 2.4). Returns `undefined` if the namespace is not present yet.
   *
   * @param ns - The namespace to read.
   * @returns The namespace's current cells (readonly), or `undefined` if absent.
   * @example
   * ```ts
   * const scores = sync.read("scores"); // { p1: 10, p2: 0 } | undefined
   * ```
   */
  read(ns: Namespace): Cells | undefined;

  /**
   * Subscribes to changes for one namespace (controller; valid host-side too). The callback fires after
   * every applied frame (snapshot or delta) that touched `ns`, with the namespace's new cells, and once
   * immediately if the namespace is already present. This is the replica's render trigger — it does NOT
   * use Moku `emit` (per-frame; spec/07 section 3).
   *
   * @param ns - The namespace to watch.
   * @param cb - Invoked with the namespace's current cells on each change.
   * @returns An unsubscribe function.
   * @example
   * ```ts
   * const off = sync.subscribe("scores", (s) => render(s));
   * off();
   * ```
   */
  subscribe(ns: Namespace, cb: (cells: Cells) => void): () => void;

  /**
   * Applies one inbound host frame to the replica (controller). Called by `transport`'s frame dispatch for
   * `t === "sync-snap"` / `t === "sync-delta"` (contracts section 2.1, section 2.2). A `sync-snap`
   * re-baselines (clears `stale`, sets `sSeq`); a `sync-delta` applies in order, or — on a gap — sets
   * `stale` and (if `resyncOnGap`) signals the host to re-snapshot. The first applied snapshot emits
   * `room:sync-ready`. Non-sync frames are ignored (defensive — transport routes by `t`).
   *
   * @param frame - The inbound `Frame` (contracts section 2.2); only `sync-snap`/`sync-delta` act.
   * @example
   * ```ts
   * transport.wire().on((peerId, frame) => sync.applyFrame(frame));
   * ```
   */
  applyFrame(frame: Frame): void;

  /**
   * Whether the first snapshot has been applied and the replica/authoritative state is readable
   * (contracts section 3.1, section 4). Mirrors `room:sync-ready` for pull-style checks (the event fires
   * once; this stays `true`).
   *
   * @returns `true` once the synced state is readable.
   * @example
   * ```ts
   * if (sync.isReady()) render(sync.read("round"));
   * ```
   */
  isReady(): boolean;

  /**
   * Exports the complete authoritative state as a plain-JSON `Snapshot` plus its current `sSeq` — the
   * exact bytes `sessionPlugin` persists for host-reload recovery (contracts section 5.1). Pure read; no
   * side effects. The codec guarantees the result is `structuredClone`/`JSON.stringify`-safe.
   *
   * @returns `{ snapshot, sSeq }` — the persistable baseline.
   * @example
   * ```ts
   * localStorage.setItem("room.snap", JSON.stringify(sync.exportSnapshot()));
   * ```
   */
  exportSnapshot(): { readonly snapshot: Snapshot; readonly sSeq: number };

  /**
   * Restores authoritative state from a persisted snapshot on host re-entry (contracts section 5.2/5.3).
   * Replaces the engine snapshot, sets `sSeq` to the restored value, marks every restored namespace
   * registered, and flips `ready`. Used ONLY by `sessionPlugin`'s recovery path — not a gameplay method.
   * After import the host re-broadcasts a fresh baseline snapshot to reconnecting controllers.
   *
   * @param snapshot - The persisted `Snapshot` (contracts section 4.1).
   * @param sSeq - The persisted host sequence to resume from (contracts section 4.3).
   * @example
   * ```ts
   * const { snapshot, sSeq } = JSON.parse(localStorage.getItem("room.snap")!);
   * sync.importSnapshot(snapshot, sSeq);
   * ```
   */
  importSnapshot(snapshot: Snapshot, sSeq: number): void;

  /**
   * Starts the host broadcast throttle loop (host only). Idempotent. Normally called by `onStart`; also
   * callable directly. Sets `broadcasting = true` and schedules the `broadcastHz` timer, storing its id in
   * `state.throttleHandle` (per-app `ctx.state`). No-op on a controller usage (no slices registered).
   *
   * @example
   * ```ts
   * sync.startBroadcast(); // begin 20-30 Hz delta fan-out
   * ```
   */
  startBroadcast(): void;

  /**
   * Stops the host broadcast throttle loop and clears the timer (host only). Idempotent. Called by
   * `onStop` (which reaches `state.throttleHandle` via the per-app `teardownRegistry` WeakMap);
   * `clearInterval`/`cancelAnimationFrame`s the handle, nulls it, sets `broadcasting = false`. Does NOT
   * clear the snapshot (a subsequent `startBroadcast` resumes).
   *
   * @example
   * ```ts
   * sync.stopBroadcast();
   * ```
   */
  stopBroadcast(): void;
};

/**
 * The internal per-app sync engine contract (built once in `api`, shared via `ctx.state.engine`). NOT
 * part of the public package surface — it is the seam between `index.ts` lifecycle wiring and the
 * `engine.ts` implementation. Owns the slice registry, the dirty-flag/throttle broadcast loop, the
 * read-only replica apply path, the per-namespace `subscribe` callback `Map` (closure scope in
 * `engine.ts`, kept out of `State` so `State.snapshot` stays plain-JSON), and the codec delegation. The
 * public `Api` is a thin delegation over these methods; the lifecycle methods drive
 * `init`/`startBroadcast`/`stopBroadcast`/`sendBaselineSnapshot`/`applyFrame` over the ONE instance.
 *
 * @example
 * ```ts
 * const engine = createSyncEngine(ctx.state, ctx.config, wire, session, ctx.emit);
 * engine.init();
 * ```
 */
export type SyncEngine = {
  /**
   * Validates config (clamps `broadcastHz` to `[5, 60]`, asserts `maxOpsPerDelta >= 0`) and attaches the
   * inbound `wire.on` receive handler routing `sync-snap`/`sync-delta` to `applyFrame`. Called by `onInit`
   * over the SHARED per-app engine. Synchronous — no timers started here.
   *
   * @throws {Error} If `broadcastHz` is wildly out of range or `maxOpsPerDelta < 0`.
   * @example
   * ```ts
   * engine.init();
   * ```
   */
  init(): void;

  /**
   * Registers a host-side typed slice (delegated from `Api.registerSlice`).
   *
   * @param ns - The namespace key.
   * @param initial - The slice's initial plain-JSON cells.
   * @throws {Error} If `ns` is re-registered with a different initial value.
   * @example
   * ```ts
   * engine.registerSlice("scores", { p1: 0, p2: 0 });
   * ```
   */
  registerSlice(ns: Namespace, initial: Cells): void;

  /**
   * Applies a host-side mutation and marks the namespace dirty (delegated from `Api.mutate`).
   *
   * @param ns - The target namespace (must be registered).
   * @param recipe - Pure function `(draft) => next` returning the namespace's next cells.
   * @throws {Error} If `ns` was never registered.
   * @example
   * ```ts
   * engine.mutate("scores", (s) => ({ ...s, p1: 1 }));
   * ```
   */
  mutate(ns: Namespace, recipe: (draft: Cells) => Cells): void;

  /**
   * Forces an immediate delta broadcast (no `peerId`) or a single-peer baseline snapshot (with `peerId`).
   *
   * @param peerId - Optional single recipient for a full snapshot; omit to broadcast a delta.
   * @example
   * ```ts
   * engine.broadcast();
   * ```
   */
  broadcast(peerId?: PeerId): void;

  /**
   * Sends a full `SyncSnapshotFrame` to one newly-joined peer (the late-join path; host only, no-op when
   * no slices are registered). Called from the `room:peer-joined` hook.
   *
   * @param peerId - The newly-joined peer to baseline.
   * @example
   * ```ts
   * engine.sendBaselineSnapshot(peerId);
   * ```
   */
  sendBaselineSnapshot(peerId: PeerId): void;

  /**
   * Registers the host-side resync handler (delegated from `Api.onResyncRequest`).
   *
   * @param handler - Invoked with the lagging controller's `peerId`.
   * @returns An unsubscribe function.
   * @example
   * ```ts
   * const off = engine.onResyncRequest((peerId) => engine.broadcast(peerId));
   * ```
   */
  onResyncRequest(handler: (peerId: PeerId) => void): () => void;

  /**
   * Reads a frozen plain-JSON copy of a namespace's cells (delegated from `Api.read`).
   *
   * @param ns - The namespace to read.
   * @returns The namespace's current cells (readonly), or `undefined` if absent.
   * @example
   * ```ts
   * engine.read("scores");
   * ```
   */
  read(ns: Namespace): Cells | undefined;

  /**
   * Subscribes to one namespace's changes (delegated from `Api.subscribe`).
   *
   * @param ns - The namespace to watch.
   * @param cb - Invoked with the namespace's current cells on each change.
   * @returns An unsubscribe function.
   * @example
   * ```ts
   * const off = engine.subscribe("scores", (s) => render(s));
   * ```
   */
  subscribe(ns: Namespace, cb: (cells: Cells) => void): () => void;

  /**
   * Applies one inbound `sync-snap`/`sync-delta` frame to the replica (delegated from `Api.applyFrame`).
   *
   * @param frame - The inbound `Frame`; only `sync-snap`/`sync-delta` act.
   * @example
   * ```ts
   * engine.applyFrame(frame);
   * ```
   */
  applyFrame(frame: Frame): void;

  /**
   * Whether the first snapshot has been applied (delegated from `Api.isReady`).
   *
   * @returns `true` once the synced state is readable.
   * @example
   * ```ts
   * engine.isReady();
   * ```
   */
  isReady(): boolean;

  /**
   * Exports the persistable baseline (delegated from `Api.exportSnapshot`).
   *
   * @returns `{ snapshot, sSeq }`.
   * @example
   * ```ts
   * engine.exportSnapshot();
   * ```
   */
  exportSnapshot(): { readonly snapshot: Snapshot; readonly sSeq: number };

  /**
   * Restores authoritative state from a persisted snapshot (delegated from `Api.importSnapshot`).
   *
   * @param snapshot - The persisted `Snapshot`.
   * @param sSeq - The persisted host sequence to resume from.
   * @example
   * ```ts
   * engine.importSnapshot(snapshot, sSeq);
   * ```
   */
  importSnapshot(snapshot: Snapshot, sSeq: number): void;

  /**
   * Starts the host throttle loop, storing the timer id in `state.throttleHandle` (delegated from
   * `Api.startBroadcast`). Idempotent.
   *
   * @example
   * ```ts
   * engine.startBroadcast();
   * ```
   */
  startBroadcast(): void;

  /**
   * Stops the host throttle loop and clears `state.throttleHandle` (delegated from `Api.stopBroadcast`).
   * Idempotent; reached by `onStop` through the `teardownRegistry` entry.
   *
   * @example
   * ```ts
   * engine.stopBroadcast();
   * ```
   */
  stopBroadcast(): void;
};
