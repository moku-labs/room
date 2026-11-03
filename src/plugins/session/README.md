# session

> **Complex tier** plugin in the `@moku-labs/room` framework. Room-lifecycle + presence authority +
> the full client-side host-reload recovery state machine (D11). `createPlugin` is imported from
> the framework via `../../config` (Room runs on `@moku-labs/core`). `depends: [transportPlugin]`.

## Responsibilities

1. **Room lifecycle** (`api.ts` + `lifecycle/`) — `createRoom()` (host, mints a room code [6 chars by
   default; see `codeLength`] + join URL + `hostToken`, synchronously), `qr()` (host, async — builds the
   join-QR matrix; the encoder is
   lazy-imported so it stays out of the controller bundle), `joinRoom(code)` (controller, passive),
   `leave()`, `rejoin()`. Delegates the SDP/ICE handshake to `transport` (the `Signaling` seam) — never
   touches `RTCPeerConnection` directly.
2. **Presence / roster** (`lifecycle/`) — stable `PeerId`, phone-persisted `reconnectToken`
   (localStorage), the 8-controller cap (`MAX_CONTROLLERS`), and STAR-TOPOLOGY enforcement (host is the
   sole hub; controller<->controller channels are rejected).
3. **Host-reload recovery** (`recovery/`) — the full CLIENT-SIDE state machine: `hostToken` minted on
   `createRoom` and verified PEER-SIDE (no server validator, D6); a debounced IndexedDB snapshot
   (~500 ms) plus a SYNCHRONOUS `localStorage` write on `visibilitychange`; re-entry by rejoining the
   SAME room code; the phone's `room:host-reconnecting` and `room:host-back`, which `intent` buffers and
   flushes on; a ~10 s reconnect timeout; the iOS "rescan the QR to rejoin" degradation.
4. **Transport event handling** (`handlers.ts`) — translates transport peer/wire signals into roster
   mutations, the four `room:*` emissions, and recovery-frame processing.

## Public API (`app.session`)

| Method | Signature | Notes |
|---|---|---|
| `createRoom` | `() => RoomDescriptor` | HOST. Returns `{ code, joinUrl, qr, hostToken }` SYNCHRONOUSLY (no `Promise`). `qr` is ALWAYS `null` here (QR generation is async) — use `qr()`. After a host reload the first call returns the restored room, with no second `connect`. Throws if already in a room. |
| `qr` | `() => Promise<QrMatrix \| null>` | HOST. Async companion to `createRoom` — builds the join-QR matrix for the open room (the `qrcode` encoder is lazy-imported host-only). `null` when `generateQr` is `false` or no room is open. Encodes the join URL ONLY — never SDP/ICE. |
| `joinRoom` | `(code: string) => Promise<JoinResult>` | CONTROLLER (passive set internally). Settles on the host's verdict, not on the open channel. `{ ok:false, reason:"full"\|"not-found"\|"unreachable" }` on failure, and the device is then in no room. See "How a join ends". |
| `leave` | `() => Promise<void>` | Ends the room: deletes the host's re-entry record. `createRoom()` then opens a new room on the same app. Idempotent. |
| `rejoin` | `() => Promise<JoinResult>` | iOS "rescan QR" path; re-uses the persisted `reconnectToken`. A failure keeps the room, so it can be repeated. |
| `roster` | `() => readonly RosterEntry[]` | Sorted defensive copy (by `joinedAt`). |
| `self` | `() => SelfInfo` | `{ selfId, role, roomCode }`. |
| `hostId` | `() => PeerId` | The host's stable peer id (the star hub). On the HOST equals `self().selfId`; on a CONTROLLER it is the resolved host id (the `IntentFrame` target), `""` until the host channel is established. Used by `intentPlugin` to address the host. |
| `persistSnapshot` | `(snapshot: Snapshot, sSeq: number) => void` | HOST-ONLY seam called by `sync`; payload is opaque. |
| `recoveryPhase` | `() => RecoveryPhase` | A controller's phase, for reconnect UX. A host's phase stays `"stable"`, also on a reload. |
| `reentryRecord` | `() => HostReentryRecord \| null` | The record this load restored. `sync` reads it in `onInit`. `null` on a first load, on a controller and after `leave()`. |
| `onRoomEnded` | `(cb: () => void) => () => void` | `cb` runs when `leave()` finishes and when a failed first join is settled, whatever the phase. Not on a failed `rejoin`, which keeps the room. No event fires on these paths. `intent` registers once in `onInit`: buffering off, buffer dropped. The list survives a `leave()`, and `app.stop()` clears it. |

## Events (Moku `emit` plane — coarse lifecycle ONLY)

Declares + emits FOUR of the seven `room:*` events: `room:peer-joined`, `room:peer-left`,
`room:host-reconnecting`, `room:host-back`. It does NOT declare `room:sync-ready` (owned by `sync`),
`room:intent-undeliverable` (owned by `intent`) or `room:network-warning` (owned by `transport`) — the
`stage`/`controller` facades re-declare all seven.

**No wire/DataChannel traffic flows through `emit`.** Recovery frames + roster broadcasts ride
`transport`'s `Wire`; `emit` carries only the four coarse `room:*` events.

## How a join ends

An open channel settles nothing, because a full host opens the channel too. `settleJoin`
(`lifecycle/join.ts`) is the one place a pending join ends:

| What the controller gets | `JoinResult` |
|---|---|
| The host's first `roster` frame | `{ ok: true, selfId }` |
| The host's `room-full` frame | `{ ok: false, reason: "full" }` |
| `transport.connect` rejects with `RoomFullError` (the hub's `full` envelope) | `{ ok: false, reason: "full" }` |
| `transport.connect` rejects with anything else | `{ ok: false, reason: "not-found" }` |
| Nothing within `reconnectTimeoutMs` | `{ ok: false, reason: "unreachable" }` |

- **Over the cap, the host** sends `room-full` to that peer and disconnects it 250 ms later
  (`REFUSE_CLOSE_DELAY_MS`): a close in the same tick lost the frame in real Chromium. The roster and
  `room:peer-joined` do not change. The peer holds no seat during the delay, and a roster frame that reaches
  it then does nothing: `room-full` went first and settled the join. `teardownSession` clears the timer, so
  none survives `stop()` or `leave()`.
- **A failed `joinRoom`** leaves no room: `role` is `"none"`, `roomCode` is `""`, `hostId()` is `""`, recovery
  is `"stable"`, transport is closed. The promise resolves after the close finished, and `close()` keeps the
  wiring, so calling `joinRoom` again on the same app retries.
- **A lost `room-full` frame** ends as `unreachable` at the timeout. The state after it is the same. On
  `serverSignaling` at the default cap the hub refuses first, so no frame is needed.
- **A retry inside the delay** finds the host still holding the old channel, and can end as `unreachable` at
  the timeout. A retry after the delay gets a fresh answer.
- **A failed `rejoin`** (and the auto-rejoin of §5.4) keeps the room: `role`, `roomCode` and transport stay, so
  it can be repeated and a host that comes back later is still adopted.
- **Host re-entry** has no join pending, so the open channel is enough: the controller adopts the connecting
  host and goes back to `"stable"`.

The `roster` frame's arrival is the admission, whatever it holds: the host sends it only to devices it
admitted. `publicRendezvous` keys the roster by Trystero's peer id, so a device cannot find its own `selfId`
in it there.

## The reload path

**On the host.** `detectHostReload` runs during `session` `onInit`: it restores the room and emits
`room:host-reconnecting`. Hooks register before any `onInit`, so a plugin's hook hears it. The host's
`recoveryPhase()` stays `"stable"`. `reentryRecord()` then hands the record to `sync`, whose `onInit` comes next.

**On a phone.**

| What happens | Phase | Event |
|---|---|---|
| The heartbeat declares the host dead | `"host-absent"`, the reconnect timer starts | `room:host-reconnecting` |
| A peer connects while the phase is not stable | `"stable"`, the reconnect timer stops | `room:host-back` |
| A peer connects while stable, and the known host is no longer connected | Through `"host-absent"` to `"stable"` | Both, once each |
| A `roster` frame comes from a peer that is not the known host | Through `"host-absent"` to `"stable"` | Both, once each |
| A first join connects | Stays `"stable"` | None |

The `roster` row is the usual case: a reload is faster than the heartbeat. `transport.peers()` still lists the
old host until the heartbeat expires, so the connect callback cannot tell this peer is the host. Only a host
sends `roster`, so that frame can. When the heartbeat then declares the old host dead, it is not the known host
any more and nothing fires.

**On `publicRendezvous`.** A phone leaves signaling once it is connected, so it cannot see the reloaded host
arrive. It finds it through its own rejoin: after `heartbeatTimeoutMs` plus `reconnectTimeoutMs`, 16 s at the
defaults. An intent older than `intent.bufferMaxAgeMs`, 10 s at the default, is dropped by then.

## Reload vs leave

The re-entry record is what makes a reload resume the room. Three things decide its fate:

| What happens | The record | The next load |
|---|---|---|
| `app.stop()`, or the page goes hidden | Written to `localStorage` | Restores the room: `role` is `"host"`, same code. The first `createRoom()` returns that room, a later one throws. |
| `session.leave()` | Deleted from `localStorage` and IndexedDB, with no final write | Starts with no room: `role` is `"none"`, and `createRoom()` mints a new code. |
| The record is older than `reentryMaxAgeMs`, or cannot be parsed | Removed on read | Starts with no room. |

Only a broadcast writes a record: `sync` calls `persistSnapshot` after it broadcasts a dirty slice. A host
that never broadcast has nothing to resume.

## Lossy intent buffering (acceptable for v1)

While the host is absent, `intent` buffers timestamped intents: its hooks follow `room:host-reconnecting` and
`room:host-back`. The cap is `intent.bufferCap` (oldest dropped first) and entries older than
`intent.bufferMaxAgeMs` are discarded on flush. This is LOSSY by design for high-frequency analog intents —
acceptable for the v1 party-game target. Do NOT assume exactly-once intent delivery across a host reload: a
restarted host has an empty `lastApplied`, so a frame the old host applied but never acked applies twice.

`recovery/buffer.ts`, the `recovery-*` frames and the `intentBufferMax*` config are not on this path.

## Host crash vs reload

A host *reload* is recoverable. A host *crash* is an UNMITIGATED v1 hard-failure (steering boundary; host
migration deferred to v2). `recovery/` does not pretend to recover a crash.

## Configuration

All fields default; override via `createApp({ pluginConfigs: { session: { ... } } })`. Defaults encode
the D11 / contracts §5 constants: `joinUrlBase:""`, `generateQr:true`, `maxControllers:8`,
`snapshotDebounceMs:500`, `reconnectTimeoutMs:10_000`, `intentBufferMax:256`, `intentBufferMaxAgeMs:8000`,
`storageKeyPrefix:"moku.room"`, `reentryMaxAgeMs:1_800_000`, `codeLength:6`.

`reentryMaxAgeMs` (default 30 min, the same as the hub's `roomTtlMs`) is the oldest host record a reload may
restore. A record exactly that old still restores; an older one is removed.

`codeLength` (default `ROOM_CODE_LENGTH` = 6) sets the generated room-code length. `serverSignaling`
deployments SHOULD set `codeLength: 8` (~57 bits) to resist room-code enumeration of the public
Durable-Object endpoint (D24, security baseline). The default (6) is unchanged for existing consumers.

## Structure

```
session/
  index.ts              # ~30-line wiring harness
  types.ts              # Config/State/API + re-exported §-types (never re-declared)
  config.ts             # typed default config + the three room:* event descriptions
  state.ts              # createSessionState (pure, minimal context)
  api.ts                # makeSessionDeps + createSessionApi (delegates to lifecycle/* + recovery/*)
  lifecycle/            # code.ts, qr.ts, roster.ts, join.ts (settleJoin)
  recovery/             # types.ts, persistence.ts, hosttoken.ts, reentry.ts, buffer.ts, timeout.ts
  handlers.ts           # wire/peer-event handler factories (thin dispatchers)
  __tests__/            # unit/ + integration/ (inMemory adapter)
```
