# @moku-labs/room

> Couch-multiplayer foundation for Moku — shared screen + phones, WebRTC peer-to-peer, multi-device state sync.

`@moku-labs/room` is a **Moku plugin pack** for building local "couch" multiplayer: one **stage** (the shared
TV / laptop screen — the authoritative host) and up to **8 controllers** (phones), connected over **direct
WebRTC DataChannels on the LAN**. Players scan a QR code on the stage to join; their inputs flow to the host,
the host owns the game state and broadcasts it back. No accounts, no lobby servers — just the devices in the room.

Room is **not** a standalone framework or app. It has no Layer-2 shell and never calls `createApp` itself. It is
built on **[`@moku-labs/web`](https://github.com/moku-labs/web)** (a peer dependency): you build your own
`@moku-labs/web` app and **spread a pre-composed Room plugin array** into it. That is the whole integration model.

---

## Table of contents

- [Overview](#overview)
- [Quick start](#quick-start)
- [Installation](#installation)
- [Usage](#usage)
- [Plugins](#plugins)
- [Configuration](#configuration)
- [Events](#events)
- [Architecture](#architecture)
- [Development](#development)
- [API reference](#api-reference)

---

## Overview

A Room session has two device roles:

- **Stage** — the shared screen (TV, laptop). It is the **host**: the authoritative star hub that owns game
  state, validates controller inputs, and broadcasts state to every controller. It calls `createRoom()` to mint a
  room code + QR.
- **Controller** — a phone. It is a passive peer that **joins** by room code, sends typed **intents** (inputs) to
  the host, and renders a **read-only replica** of the host's state.

Discovery and connection:

1. The stage calls `createRoom()` → a **6-char room code** + a join URL + a QR matrix.
2. Both devices join a **public rendezvous** (Trystero over a Nostr backbone, by default) keyed by that code.
3. They exchange SDP/ICE over the public relays — a **one-time handshake only**.
4. They then talk over **direct peer-to-peer DataChannels on the LAN**. The rendezvous backbone never carries
   gameplay; once connected, the relay is discarded.

Two communication planes, kept strictly separate:

- **The `Wire`** (`Frame` DataChannel) — **all gameplay**: intents, state snapshots, deltas, heartbeats, recovery.
- **Moku `emit` (`room:*` events)** — **coarse lifecycle only**: peer joined/left, host reconnecting, sync ready,
  network warning. No gameplay payload ever rides `emit`.

> **No game server (accepted hard-failure risk, D2).** Room is strictly peer-to-peer with **no TURN relay, ever**.
> On AP-isolated / symmetric-NAT / iOS-Private-Relay networks (~15–30% in the wild) the P2P connection **cannot be
> established and there is no recovery path** — it hard-fails and surfaces `room:network-warning`. Room's design
> target is the **home LAN** (everyone in the same room on the same Wi-Fi). Surface the warning event as failure UX.

---

## Quick start

Room ships two pre-composed plugin arrays — `roomPlugins.stage` and `roomPlugins.controller` — that you spread
into a `@moku-labs/web` app. Import the role facade you compose against from `@moku-labs/room`, and `createApp`
from `@moku-labs/web`.

> The DOM/WebRTC build target is `@moku-labs/room/browser` — use it in a browser context. (`@moku-labs/room` and
> `@moku-labs/room/browser` expose the identical surface; the browser entry is the one a browser app imports.)

### Stage (the shared screen / host)

```typescript
import { createApp, createPlugin } from "@moku-labs/web/browser";
import { roomPlugins, stagePlugin } from "@moku-labs/room/browser";

// Your game logic — depends on the facade so the five room:* events are visible (WARN-2).
const game = createPlugin("game", {
  depends: [stagePlugin],
  hooks: ctx => ({
    "room:peer-joined": ({ peerId }) => ctx.log.info(`controller joined: ${peerId}`),
    "room:network-warning": ({ reason }) => ctx.log.warn(`network: ${reason}`)
  })
});

const app = createApp({
  // facade LAST so it sees all four engines' events; the game plugin composes after it.
  plugins: [...roomPlugins.stage, game]
});

await app.start();

// createRoom() is SYNCHRONOUS — it returns the descriptor directly (no await).
const { code, joinUrl } = app.stage.createRoom();
showJoinCode(code, joinUrl);
// The join QR is async (descriptor.qr is always null) — fetch + render it from the qr() accessor.
const qr = await app.stage.qr();
if (qr) renderJoinQr(qr); // show the QR on the TV; phones scan it to join

// Own authoritative state: register a slice, react to intents, mutate.
app.stage.onIntent("score", (payload, peerId) => {
  app.stage.mutate("scores", draft => ({
    ...draft,
    [peerId]: ((draft[peerId] as number) ?? 0) + 1
  }));
});
```

### Controller (the phone)

```typescript
import { createApp, createPlugin } from "@moku-labs/web/browser";
import { roomPlugins, controllerPlugin } from "@moku-labs/room/browser";

const pad = createPlugin("pad", {
  depends: [controllerPlugin],
  hooks: ctx => ({
    "room:sync-ready": () => ctx.log.info("replica is readable"),
    "room:host-reconnecting": () => ctx.log.info("host reloading — show reconnecting UX")
  })
});

const app = createApp({
  plugins: [...roomPlugins.controller, pad]
});

await app.start();

// Join with the code scanned from the stage's QR. Throws on "full" | "not-found" | "unreachable".
await app.controller.joinRoom("K7P2Q9");
await app.controller.requestWakeLock(); // keep the phone screen awake for the session (iOS)

// Read the read-only replica + subscribe to changes.
const off = app.controller.on("round", round => render(round));

// Send a typed input to the host over the Wire (never emit).
app.controller.intent("move", { dx: 1, dy: 0 });
```

> If the exact `@moku-labs/web` `createApp` signature differs in your version, keep your app config minimal and
> see the [`@moku-labs/web` docs](https://github.com/moku-labs/web) — Room only requires that you spread one of the
> `roomPlugins` arrays into `plugins`.

---

## Installation

This project uses **bun** exclusively.

```bash
bun add @moku-labs/room
bun add @moku-labs/web   # peer dependency, ^1.12.4 — supplies createApp / createPlugin + ctx.log / ctx.env
```

- **Peer dependency:** `@moku-labs/web` `^1.12.4` (you install it; Room never imports `@moku-labs/core` directly).
- **Bundled dependencies** (installed automatically): `trystero` `~0.25.2` (the default public-rendezvous signaling
  backbone) and `qrcode` `^1.5.4` (join-QR generation).
- **Engines:** Node `>=24`, bun `>=1.3.14`.

Entry points:

| Import | Use |
|---|---|
| `@moku-labs/room` | Main entry — re-exports the full surface (Node/tooling, tests). |
| `@moku-labs/room/browser` | DOM/WebRTC build target — what a browser app imports. |

---

## Usage

### Compose a stage vs a controller app

Spread the matching pre-composed array into your `@moku-labs/web` `createApp`. The arrays are:

```typescript
roomPlugins.stage      = [transportPlugin, sessionPlugin, intentPlugin, syncPlugin, stagePlugin];
roomPlugins.controller = [transportPlugin, sessionPlugin, intentPlugin, syncPlugin, controllerPlugin];
```

The role **facade is last** in each array so it can re-declare all five `room:*` events and a downstream game
plugin (`depends: [stagePlugin]` / `[controllerPlugin]`) sees the complete typed hook surface in one edge.

### Reach the role API

The facade's API is reached off the app by plugin name:

- Stage: **`app.stage`** → `StageApi` (`createRoom`, `qr`, `mutate`, `broadcast`, `onIntent`, `roster`).
- Controller: **`app.controller`** → `ControllerApi` (`joinRoom`, `read`, `on`, `intent`, `requestWakeLock`,
  `releaseWakeLock`).

Inside a game plugin you can also resolve it with `ctx.require(stagePlugin)` / `ctx.require(controllerPlugin)`.

### Choose a signaling adapter

The transport plugin's `signaling` config selects the rendezvous backbone (the `Signaling` seam, D12):

- **`publicRendezvous()`** — **default**. Trystero v0.25.x over a public Nostr backbone. Use in production.
- **`inMemory()`** — in-process, no `RTCPeerConnection`. Use for tests / simulation (deterministic, no relays).

```typescript
import { createApp } from "@moku-labs/web/browser";
import { roomPlugins, inMemory } from "@moku-labs/room";

const app = createApp({
  plugins: roomPlugins.stage,
  pluginConfigs: { transport: { signaling: inMemory(), iceServers: [] } } // LAN-only, deterministic
});
```

---

## Plugins

Six plugins, dependency-ordered. The first four are **engines**; the last two are **role facades** (one ergonomic
surface over the four engines).

| # | Plugin | Tier | Depends on | Role / key surface |
|---|--------|------|-----------|--------------------|
| 1 | `transportPlugin` | Complex | — | WebRTC DataChannels: signaling handshake, chunking/backpressure, mandatory heartbeat, capped ICE recovery. Owns the typed `Wire`. API: `connect`, `wire`, `disconnect`, `peers`, `close`. Emits `room:network-warning`. |
| 2 | `sessionPlugin` | Complex | transport | Room code + QR + roster; star topology (`hostId()`); client-side host-reload recovery. API: `createRoom`, `qr`, `joinRoom`, `leave`, `rejoin`, `roster`, `self`, `recoveryPhase`. Emits `room:peer-joined`, `room:peer-left`, `room:host-reconnecting`. |
| 3 | `intentPlugin` | Standard | transport, session | Controller→host typed inputs (`IntentFrame`, per-controller `cSeq` idempotent de-dup). API: `register`, `onIntent`, `intent`, buffer seam. No events. |
| 4 | `syncPlugin` | Complex | transport, session | Host→controller authoritative state: full snapshot + throttled op-list deltas (custom codec). API: `registerSlice`, `mutate`, `broadcast`, `read`, `subscribe`, `applyFrame`. Emits `room:sync-ready`. |
| 5 | `stagePlugin` | Standard (facade) | all four | **Host-role facade** → `StageApi` (`app.stage`). Re-declares all five `room:*` events. |
| 6 | `controllerPlugin` | Standard (facade) | all four | **Controller-role facade** → `ControllerApi` (`app.controller`). Re-declares all five `room:*` events. |

**On the facades (D19):** they **re-declare** the `room:*` events for *compile-time visibility* to a game plugin
that `depends` on them (event-type visibility is not transitive). They install **no forwarding hooks** — Moku's
event bus is **global**, so engines' `emit("room:*")` already reaches every hook regardless of `depends`. The
facades delegate API methods; they do not re-emit or proxy events.

---

## Configuration

Override any field via `createApp({ pluginConfigs: { <plugin>: { ... } } })`. All fields have safe defaults — the
verified "couch" profile — so composing `roomPlugins.stage` / `roomPlugins.controller` needs **zero overrides**.

### `transport`

| Field | Type | Default | Description |
|---|---|---|---|
| `signaling` | `Signaling` | `publicRendezvous()` | The signaling seam (handshake broker), discarded once connected. |
| `iceServers` | `readonly RTCIceServer[]` | one public STUN (`stun.l.google.com:19302`) | ICE servers for every connection. `[]` forces LAN-only (mDNS). **No TURN is ever added** (D2). |
| `heartbeatIntervalMs` | `number` | `2000` | App-layer ping interval. **Mandatory** — WebKit `onclose` doesn't fire on iOS. |
| `heartbeatTimeoutMs` | `number` | `6000` | No-`pong` window before a peer is declared dead (small multiple of the interval). |
| `openTimeoutMs` | `number` | `3000` | DataChannel-open timeout before retrying the handshake (iOS↔Bravia mitigation; capped). |
| `maxMessageBytes` | `number` | `14336` | Chunk threshold (~14 KiB UTF-8); larger frames are split + reassembled. |

### `session`

| Field | Type | Default | Description |
|---|---|---|---|
| `joinUrlBase` | `string` | `""` | Origin for the join URL (`${joinUrlBase}?room=CODE`). Empty = use `location.origin` at runtime. |
| `generateQr` | `boolean` | `true` | Whether `createRoom()` produces QR matrix data. `false` skips QR work (headless tests). |
| `maxControllers` | `number` | `8` (`MAX_CONTROLLERS`) | Max simultaneous controllers (excludes host). Lowering is fine; >8 is not recommended. |
| `snapshotDebounceMs` | `number` | `500` | Debounce for the durable IndexedDB host-snapshot write during play. |
| `reconnectTimeoutMs` | `number` | `10000` | How long a controller waits for a reloaded host before degrading to "rescan QR". |
| `intentBufferMax` | `number` | `256` | Ring-buffer cap for intents buffered during host absence (oldest dropped). |
| `intentBufferMaxAgeMs` | `number` | `8000` | Max age of a buffered intent before it is discarded on flush (lossy by design). |
| `storageKeyPrefix` | `string` | `"moku.room"` | localStorage key prefix for the phone `reconnectToken` + host re-entry record. |

### `intent`

| Field | Type | Default | Description |
|---|---|---|---|
| `bufferCap` | `number` | `256` | Max controller-side intents buffered during host absence (FIFO drop). |
| `bufferMaxAgeMs` | `number` | `10000` | Max age of a buffered intent before prune; should be `>=` session's reconnect timeout. |

### `sync`

| Field | Type | Default | Description |
|---|---|---|---|
| `broadcastHz` | `number` | `30` | Authoritative broadcast rate (coalesces mutates into one delta per tick). Verified safe band 20–30 Hz; clamped to `[5, 60]`. |
| `skipEmptyDeltas` | `boolean` | `true` | When `true`, a no-change tick sends no `SyncDeltaFrame` (saves idle fan-out). |
| `maxOpsPerDelta` | `number` | `512` | Max `Op` cells per delta before an extra frame is forced (bounds JSON size under the chunk threshold). `0` disables the cap. |
| `resyncOnGap` | `boolean` | `true` | When `true`, a controller's detected sequence gap surfaces the host `onResyncRequest` hook to re-snapshot that peer. |

### `stage` / `controller`

**No config** — the facades own no tunables. Every host/controller knob lives on the engine that owns the concern
(set it in `pluginConfigs` under `transport` / `session` / `intent` / `sync`). The controller's wake-lock behavior
is opt-in via the `requestWakeLock()` API, not a config flag.

---

## Events

The `room:*` plane is **coarse lifecycle only** — declared via Moku `emit`. **All gameplay rides the `Wire`
(`Frame`s), never these events.** Each event is owned/emitted by one engine; the facades re-declare all five so a
`depends`-ing game plugin sees the full set.

| Event | Payload | Emitted by | Meaning |
|---|---|---|---|
| `room:peer-joined` | `{ peerId: PeerId }` | session | A controller's DataChannel reached `connected` and was added to the roster. |
| `room:peer-left` | `{ peerId: PeerId }` | session | A controller left or was declared dead by the heartbeat; removed from roster. |
| `room:host-reconnecting` | `Record<string, never>` (`{}`) | session | Host tab reloaded; client-side recovery in flight — show "reconnecting" UX. |
| `room:sync-ready` | `Record<string, never>` (`{}`) | sync | First full snapshot applied; the synced replica is now readable. |
| `room:network-warning` | `{ reason: "ice-failed" \| "rendezvous-unreachable" \| "channel-closed" }` | transport | A connectivity hard-failure surfaced for failure UX (D2 accepted hard-failure). |

> **Reload-path timing caveat.** `room:host-reconnecting` is emitted during `session` `onInit`, before downstream
> consumer hooks are registered. On the reload path, **poll `app.session.recoveryPhase()`** in your own
> `onInit`/`onStart` (a non-`"stable"` phase means recovery is in flight) rather than relying on the event. The
> event remains useful for steady-state (non-reload) detection.

---

## Architecture

### Dependency graph

```
transport ──> session ──> intent ─┐
   │            │                  ├──> stage       (host facade)   = roomPlugins.stage
   │            └──────> sync  ────┤
   └───────────────────────────────└──> controller (phone facade)  = roomPlugins.controller
```

Initialization order = array order; the **facade is last** so all four engines' events are mergeable into its
re-declared set. `intent` and `sync` are parallel siblings (both depend on transport + session; neither depends on
the other).

### Two planes — wire vs. events

- **`Wire` (`Frame` DataChannel)** carries **all gameplay**: `IntentFrame` (controller→host inputs),
  `SyncSnapshotFrame` / `SyncDeltaFrame` (host→controller state), `HeartbeatPingFrame` / `HeartbeatPongFrame`
  (liveness), and the recovery frames. `Wire = { send(peerId, frame), broadcast(frame), on(handler) }`. On a
  controller, `send`/`broadcast` collapse to "send to host".
- **Moku `emit` (`room:*`)** carries **only coarse lifecycle** (the five events above). Nothing in `Frame` ever
  flows through `emit`, and no `room:*` event ever carries gameplay.

### Discovery + connection (star topology)

The **stage is the authoritative star hub**; controllers are spokes — there are **no controller↔controller**
channels. Up to **8 controllers** (`MAX_CONTROLLERS`). Flow: `createRoom()` → 6-char code (`ROOM_CODE_LENGTH`) →
QR → both devices join the public rendezvous → SDP/ICE handshake over public relays → **direct P2P DataChannels on
the LAN**. The rendezvous is one-time; gameplay never touches it.

### The `Signaling` seam (D12)

Transport talks to discovery only through the DOM-free `Signaling` contract (`join(code, opts) → SignalingSession`).
Adapters are interchangeable with zero transport changes: **`publicRendezvous()`** (default, Trystero),
**`inMemory()`** (tests), and a future server-side adapter (Workers/Node). The contract is deliberately DOM-free so
it stays portable off the browser.

### Host-reload recovery

A host **tab reload** is recoverable (a host **crash** is an unmitigated v1 hard-failure — host migration is
deferred to v2). On `createRoom`, the host mints a `hostToken` (`crypto.randomUUID()`) and persists a snapshot
(debounced IndexedDB write + a synchronous `localStorage` write on `visibilitychange`). After a reload it resumes
the **same room code**, verifies the `hostToken` **peer-side** (no server validator, D6), and re-baselines
controllers with a fresh snapshot. Controllers buffer intents during the absence and flush them on reconnect
(idempotent by `cSeq`; lossy by design for high-frequency inputs). On iOS the path degrades to **"rescan the QR to
rejoin"** (`app.session.rejoin()`).

### iOS caveats

- **Heartbeat is mandatory** — WebKit's DataChannel `onclose` does not fire on iOS, so dead peers are detected only
  by the app-layer ping/pong (`HeartbeatPingFrame` / `HeartbeatPongFrame`).
- **Screen Wake Lock** (controller, Safari 16.4+) keeps the phone from dimming/locking and suspending its
  DataChannel mid-session — opt in via `requestWakeLock()`.
- **Recovery degrades** to rescan-QR on iOS rather than silent auto-rejoin.

> **D2 accepted-risk callout (repeated because it matters).** Strict no-server P2P with **no TURN**. On
> AP-isolated / symmetric-NAT / iOS-Private-Relay networks the connection can hard-fail with **no recovery path**,
> surfacing `room:network-warning`. Design target: the home LAN, everyone on the same Wi-Fi.

---

## Development

This project uses **bun**.

| Script | Command | What it does |
|---|---|---|
| Build | `bun run build` | Build with tsdown. |
| Lint | `bun run lint` | Biome check + ESLint. |
| Lint (fix) | `bun run lint:fix` | Auto-fix Biome + ESLint. |
| Format | `bun run format` | Format with Biome. |
| Test | `bun run test` | Run all tests (vitest). |
| Unit tests | `bun run test:unit` | Unit project only. |
| Integration tests | `bun run test:integration` | Integration project only. |
| Coverage | `bun run test:coverage` | Tests with coverage (90% threshold). |
| Validate package | `bun run validate` | `publint` + `attw` (export-map / types correctness). |

### Test layout

- **Framework-level** tests live in root `tests/unit/` and `tests/integration/` (cross-plugin scenarios).
- **Plugin-specific** tests are colocated: `src/plugins/<name>/__tests__/unit/` and `__tests__/integration/`.
- Integration tests use the `inMemory()` signaling adapter (no relays, deterministic).

### Adding a plugin

Plugins live in `src/plugins/<name>/` and are created with `createPlugin` from `@moku-labs/web` (Room never imports
`@moku-labs/core`). Export the instance from `src/index.ts`. Each shared cross-cutting type belongs in
`src/contracts.ts` (the single physical home, D16) — never re-declared per plugin. Engines own the `Wire`/state;
facades delegate and own no state.

---

## API reference

Per-plugin READMEs (full API shapes, config, and usage):

- [transport](src/plugins/transport/README.md) — WebRTC floor + `Wire` + signaling adapters.
- [session](src/plugins/session/README.md) — room code/QR/roster + host-reload recovery.
- [intent](src/plugins/intent/README.md) — controller→host typed inputs.
- [sync](src/plugins/sync/README.md) — authoritative state snapshot + deltas.
- [stage](src/plugins/stage/README.md) — host-role facade (`StageApi`).
- [controller](src/plugins/controller/README.md) — controller-role facade (`ControllerApi`).

Shared contract types (`Signaling`, `Wire`, every `Frame`, `RoomEvents`, `Snapshot`, `Op`, `RosterEntry`,
`MAX_CONTROLLERS`, `ROOM_CODE_LENGTH`, …) live in [`src/contracts.ts`](src/contracts.ts).
