# sync

[![tier: Complex](https://img.shields.io/badge/tier-Complex-orange)](#) **role-agnostic authoritative sync engine**

Room's **role-agnostic authoritative sync engine** (D4). The host owns a map of namespaced typed slices,
`mutate`s them, and broadcasts the changes; every controller holds a **read-only replica** of the same
`Snapshot` shape. On a fresh join / late-join / reconnect the host sends that one peer a full snapshot;
in steady state it broadcasts **sequence-numbered op-list delta patches** coalesced at a **20-30 Hz
throttle** (decoupled from the 60 Hz game loop). Controllers apply `sync-snap` / `sync-delta` frames in
`sSeq` order and re-render via per-namespace `subscribe` callbacks; a detected sequence gap requests a
fresh snapshot rather than applying out of order. Encoding/decoding lives in a **pure `codec.ts`**. The
same plugin runs on the stage and on every controller — the *role* is determined by which API methods a
facade calls, not by a branch in this plugin. All frame I/O rides `transport` (contracts section 2) —
never Moku `emit`; the only event this engine emits is `room:sync-ready`.

## Config

Flat config; all fields have safe defaults (the verified couch profile), so composing
a stage/controller app needs zero overrides.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `broadcastHz` | `number` | `30` | Authoritative broadcast rate in Hz — the throttle loop coalesces all mutates within a tick into one `SyncDeltaFrame` at this cadence, independent of the 60 Hz game loop. Verified safe band is 20-30 Hz; clamped to `[5, 60]` in `onInit` (contracts section 4.3). |
| `skipEmptyDeltas` | `boolean` | `true` | When `true`, a no-change tick sends NO broadcast (no `SyncDeltaFrame` when zero namespaces are dirty), saving the O(N) fan-out on idle frames. Set `false` only for a heartbeat-style diagnostic. |
| `maxOpsPerDelta` | `number` | `512` | Maximum `Op` cells batched into a single `SyncDeltaFrame` before an extra frame is forced in the same tick — bounds per-frame JSON size under the ~14 KiB transport chunk threshold (contracts section 2.3). `0` disables the cap (rely on transport chunking). |
| `resyncOnGap` | `boolean` | `true` | When a controller detects a sequence gap (`incoming.sSeq > local.sSeq + 1`, contracts section 4.3) and `true`, the engine surfaces the host-side `onResyncRequest` hook so the host can re-snapshot that peer; when `false`, the controller waits for the next host snapshot. |

Framework-level overrides live in Web's `pluginConfigs.sync`; consumer apps override per-app via
`createApp({ pluginConfigs: { sync: { broadcastHz: 20 } } })`.

## API

The surface is role-agnostic (D4/D5): host methods write/broadcast authoritative state, controller
methods read/apply the replica, and the recovery methods are the persistence seam `sessionPlugin` calls
(contracts section 5). Frame I/O rides `transport` (contracts section 2) — never Moku `emit`.

**Host**

### `registerSlice(ns: Namespace, initial: { readonly [key: string]: JsonValue }): void`

Registers a namespaced typed slice with its initial value (D4). Call ONCE per namespace, host-side,
before the first broadcast. Idempotent re-register with the same initial is a no-op; a different initial
throws. The first `registerSlice` makes the host's snapshot readable.

### `mutate(ns: Namespace, recipe: (draft: { readonly [key: string]: JsonValue }) => { readonly [key: string]: JsonValue }): void`

Mutates a registered slice (host only). `recipe` receives a draft of the namespace's cells and returns
the next cells; the engine diffs old vs. next to compute the `Op[]`. Marks the namespace dirty; does NOT
broadcast synchronously — the next throttle tick coalesces and broadcasts (contracts section 4.3). Throws
if `ns` was never registered.

### `broadcast(peerId?: PeerId): void`

Forces an immediate authoritative broadcast (host only), bypassing the next throttle tick. With `peerId`,
sends a full `SyncSnapshotFrame` to that single peer (late-join / reconcile, contracts section 5.3);
without it, broadcasts a `SyncDeltaFrame` to every controller. No-op when nothing is dirty and
`skipEmptyDeltas`.

### `onResyncRequest(handler: (peerId: PeerId) => void): () => void`

Registers the host-side resync handler fired when a controller reports a sequence gap (only when
`config.resyncOnGap`). The handler typically calls `broadcast(peerId)` to re-baseline that one peer
(contracts section 4.3, section 5.3). Returns an unsubscribe function.

**Controller**

### `read(ns: Namespace): { readonly [key: string]: JsonValue } | undefined`

Reads the current replica value of a namespace (also valid host-side as a readonly view). Returns a
structurally-frozen, plain-JSON copy of the namespace's cells — never a live reference into engine state.
Returns `undefined` if the namespace is not present yet.

### `subscribe(ns: Namespace, cb: (cells: { readonly [key: string]: JsonValue }) => void): () => void`

Subscribes to changes for one namespace. The callback fires after every applied frame (snapshot or delta)
that touched `ns`, with the namespace's new cells, and once immediately if the namespace is already
present. This is the replica's render trigger — it does NOT use Moku `emit`. Returns an unsubscribe
function.

### `applyFrame(frame: Frame): void`

Applies one inbound host frame to the replica (controller). Called by `transport`'s frame dispatch for
`sync-snap` / `sync-delta` (contracts section 2.1, section 2.2). A `sync-snap` re-baselines (clears
`stale`, sets `sSeq`); a `sync-delta` applies in order, or — on a gap — sets `stale` and (if
`resyncOnGap`) signals the host to re-snapshot. The first applied snapshot emits `room:sync-ready`.
Non-sync frames are ignored.

### `isReady(): boolean`

Whether the first snapshot has been applied and the synced state is readable (contracts section 3.1,
section 4). Mirrors `room:sync-ready` for pull-style checks.

**Shared / Recovery seam (consumed by `sessionPlugin`, contracts section 5)**

### `exportSnapshot(): { readonly snapshot: Snapshot; readonly sSeq: number }`

Exports the complete authoritative state as a plain-JSON `Snapshot` plus its current `sSeq` — the exact
bytes `sessionPlugin` persists for host-reload recovery (contracts section 5.1). Pure read; the result is
`structuredClone` / `JSON.stringify`-safe.

### `importSnapshot(snapshot: Snapshot, sSeq: number): void`

Restores authoritative state from a persisted snapshot on host re-entry (contracts section 5.2/5.3).
Replaces the engine snapshot, sets `sSeq`, marks every restored namespace registered, and flips `ready`.
Used ONLY by `sessionPlugin`'s recovery path. After import the host re-broadcasts a fresh baseline
snapshot.

### `startBroadcast(): void`

Starts the host broadcast throttle loop (host only). Idempotent. Normally called by `onStart`; sets
`broadcasting = true` and schedules the `broadcastHz` timer. No-op on a controller (no slices registered).

### `stopBroadcast(): void`

Stops the host broadcast throttle loop and clears the timer (host only). Idempotent. Called by `onStop`;
`clearInterval` / `cancelAnimationFrame`s the handle, nulls it, and sets `broadcasting = false`. Does NOT
clear the snapshot (a subsequent `startBroadcast` resumes).

## Events

Owns and declares exactly **one** event — `room:sync-ready` (contracts section 3.1) — via the bulk
`register.map` form over the subset it owns. All other `room:*` events belong to `transport` / `session`;
the facades (`stage` / `controller`) re-declare the full map. No per-frame events: `sync-snap` /
`sync-delta` are contracts section 2 `Frame`s on the wire, never Moku events (spec/07 section 3; spec/11
section 2.7).

| Event | Payload | Description |
|-------|---------|-------------|
| `room:sync-ready` | `Record<string, never>` (`{}`) | First authoritative snapshot applied; the synced replica is now readable. Emitted exactly once, on the `ready` transition `false -> true` (host: after the first `registerSlice` + baseline export; controller: on the first applied `sync-snap`). |

## Dependencies

| Plugin | Role | Reason |
|--------|------|--------|
| `transportPlugin` | required engine | Broadcasting frames + receiving inbound sync frames. `ctx.require(transportPlugin).wire()` yields the contracts section 2 `Wire`, whose `broadcast(frame)`, `send(peerId, frame)`, and `on(handler)` carry ALL sync wire I/O (host deltas, single-peer snapshots, inbound routing). Never `emit`. |
| `sessionPlugin` | required engine | Roster / `PeerId` access for single-peer baseline snapshots on join/late-join (contracts section 6), the `room:peer-joined` hook that triggers a baseline snapshot for a new peer, and the recovery seam (`session` calls `exportSnapshot()` / `importSnapshot()` on the persist cadence and on re-entry, contracts section 5). |

`intentPlugin` is **not** a dependency: the host applies a `mutate` as a result of a game-defined
`onIntent` handler, but that call originates in the game plugin, not in `sync` (the two are parallel in
Wave 3, D5).

## Usage

The host registers slices and mutates them; controllers read the replica and subscribe to changes. A game
plugin reaches `sync` through a role facade (`stagePlugin` / `controllerPlugin`), but the engine surface
is the same on both roles:

```typescript
// Host (stage) — register each typed slice once, then mutate; the throttle loop broadcasts at 20-30 Hz.
sync.registerSlice("scores", { p1: 0, p2: 0 });
sync.registerSlice("round", { n: 1, phase: "lobby" });

// Typically called from the game's onIntent handler. mutate marks the namespace
// dirty; the next throttle tick coalesces and broadcasts a sequence-numbered delta.
sync.mutate("scores", s => ({ ...s, p1: (s.p1 as number) + 10 }));

// Controller — read the read-only replica, and subscribe to re-render on each applied frame.
const scores = sync.read("scores"); // { p1: 10, p2: 0 } | undefined

const off = sync.subscribe("scores", cells => render(cells));
off();
```
