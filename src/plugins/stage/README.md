# stage

[![tier: Standard](https://img.shields.io/badge/tier-Standard-blue)](#) **HOST-role facade**

The thin **HOST-role facade** a couch-multiplayer game plugin composes against to drive the
authoritative TV stage. It owns no state, runs no resource, and contains no business logic: every
method delegates via `ctx.require(...)` to one of the four engines it depends on (`transport`,
`session`, `intent`, `sync`), and it re-declares + forwards all five `room:*` lifecycle events so a
game plugin with `depends: [stagePlugin]` gets the complete, typed hook surface in one edge (WARN-2 —
event visibility is not transitive: spec/07 §5, spec/14 §7). Shipped pre-composed as
`roomPlugins.stage = [transport, session, intent, sync, stage]`.

## API

### `createRoom(): RoomDescriptor`

Creates and hosts a new room. Delegates to `session.createRoom()`, which mints the 6-char room code
(contracts §6.2) + `hostToken` (contracts §5.1), joins the signaling rendezvous as the active offerer,
and accepts controllers up to `MAX_CONTROLLERS` (contracts §6). Room-code generation is **synchronous**,
so this returns the `RoomDescriptor` **directly — not a promise**. Returns `{ code, joinUrl, qr,
hostToken }`: the room code, the join URL, the QR matrix to render (code/URL only, never SDP/ICE), and
the `hostToken` re-entry credential.

### `mutate(ns: Namespace, recipe: MutateRecipe): void`

Mutates one authoritative namespaced sync slice on the host. Delegates to `sync.mutate(ns, recipe)`,
which applies the recipe to the slice's cells, advances `sSeq`, and schedules a throttled (20–30 Hz)
delta broadcast to every controller (contracts §4.3). The only way the host changes shared state.

### `broadcast(): void`

Forces an immediate full authoritative snapshot broadcast to all controllers. Delegates to
`sync.broadcast()`. Only needed to flush a snapshot outside the normal throttle cadence (e.g. round
transition); idempotent and safe to over-call (contracts §4.3, §5.3).

### `onIntent(name: string, handler: IntentHandler): () => void`

Registers a typed host-side handler for a named controller intent. Delegates to `intent.onIntent`,
adapting the engine's `(payload, meta)` callback to this facade's `(payload, peerId)` surface (it
unwraps `meta.peerId`). `intent` correctness-only shape-checks each payload (D6) and drops any
`cSeq <= lastApplied[peerId]` (contracts §4.3) before the handler runs. The handler is invoked with
`(payload, peerId)`. Returns an unsubscribe function.

### `roster(): readonly RosterEntry[]`

Returns a snapshot of the current connected-controller roster (contracts §6.1). Delegates to
`session.roster()`. Read-only; reflects the roster at call time (entries added on `room:peer-joined`,
removed on `room:peer-left`/heartbeat-dead).

## Events

Re-declared from `00-contracts.md` §3 (identical payloads) and forwarded unchanged from the owning
engine, so a `depends: [stagePlugin]` game plugin receives the complete lifecycle surface (WARN-2).
Coarse lifecycle only — no gameplay payload ever flows through `emit` (spec/07 §3).

| Event | Payload | Description |
|-------|---------|-------------|
| `room:peer-joined` | `{ peerId: PeerId }` | A controller's DataChannel reached `connected` and joined the roster (contracts §3, §6). |
| `room:peer-left` | `{ peerId: PeerId }` | A controller left or was declared dead by the heartbeat and left the roster (contracts §2.4, §3). |
| `room:host-reconnecting` | `Record<string, never>` (`{}`) | Host tab reloaded; client-side recovery is in flight (contracts §5). |
| `room:sync-ready` | `Record<string, never>` (`{}`) | First full snapshot applied; the synced replica is now readable (contracts §4). |
| `room:network-warning` | `{ reason: "ice-failed" \| "rendezvous-unreachable" \| "channel-closed" }` | A connectivity hard-failure surfaced for failure UX (contracts §3, D2). |

## Dependencies

| Plugin | Role | Reason |
|--------|------|--------|
| `transportPlugin` | visibility-only | Listed in `depends` solely so `transport`'s `room:network-warning` is mergeable for re-declaration + forwarding (WARN-2). No method is ever `require`d. |
| `sessionPlugin` | delegation target | `createRoom()` / `roster()` delegate here; owns room-code/QR/roster (contracts §6) + recovery (§5); source of `room:peer-joined`/`-left`/`host-reconnecting`. |
| `intentPlugin` | delegation target | `onIntent()` delegates here; owns intent validation + `cSeq` de-dup (contracts §4.3). |
| `syncPlugin` | delegation target | `mutate()` / `broadcast()` delegate here; owns the authoritative snapshot + op-list (contracts §4); source of `room:sync-ready`. |

> No **Config** section: the facade has no config of its own. Every host tunable (STUN servers,
> signaling adapter, broadcast Hz, heartbeat cadence, reconnect timeout, room-code alphabet) belongs to
> the engine that owns the concern and is set in `pluginConfigs` by the consuming app (spec/15 §6 —
> omit sections that don't apply).

## Usage

A game plugin composes the pre-bundled `roomPlugins.stage`, drives the stage through `app.stage.*`, and
hooks the `room:*` lifecycle by declaring `depends: [stagePlugin]` (which is how all five events become
visible — WARN-2):

```typescript
import { createApp, createPlugin } from "@moku-labs/web";
import { roomPlugins, stagePlugin } from "@moku-labs/room";

// A couch-multiplayer game plugin that drives the host stage.
const scoreboardGame = createPlugin("scoreboardGame", {
  // depends on the facade — this is what makes the five room:* events visible (WARN-2).
  depends: [stagePlugin],

  // Hook the forwarded lifecycle events. Payloads come from contracts §3.
  hooks: ctx => ({
    "room:peer-joined": ({ peerId }) => ctx.log.info(`controller joined: ${peerId}`),
    "room:sync-ready": () => ctx.log.info("replica is readable"),
    "room:network-warning": ({ reason }) => ctx.log.warn(`network: ${reason}`)
  })
});

// roomPlugins.stage = [transport, session, intent, sync, stage] — facade LAST so its
// depends array is satisfied by array order; the game plugin composes after it.
const app = createApp({
  plugins: [...roomPlugins.stage, scoreboardGame]
});

await app.start();

// Drive the host stage through the single facade surface.
// createRoom() is synchronous — it returns the RoomDescriptor directly (no await).
const { joinUrl } = app.stage.createRoom();
renderJoinQr(joinUrl);

app.stage.onIntent("score", (payload, peerId) => {
  app.stage.mutate("scores", draft => {
    draft[peerId] = ((draft[peerId] as number) ?? 0) + 1;
  });
});

const players = app.stage.roster(); // readonly RosterEntry[] (contracts §6.1)
```
