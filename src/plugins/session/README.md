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
2. **Presence / roster** (`lifecycle/`) — a stable `PeerId` saved per tab and room in `sessionStorage` (see
   "A phone reload"), the 8-controller cap (`MAX_CONTROLLERS`), and STAR-TOPOLOGY enforcement (host is the
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
| `joinRoom` | `(code: string) => Promise<JoinResult>` | CONTROLLER (passive set internally). Loads or mints this tab's `selfId` for `code`. Settles on the host's verdict, not on the open channel. `{ ok:false, reason:"full"\|"not-found"\|"unreachable" }` on failure, and the device is then in no room. See "How a join ends". |
| `leave` | `() => Promise<void>` | Ends the room: deletes the host's re-entry record and this tab's saved `selfId`. `createRoom()` then opens a new room on the same app. Idempotent. |
| `rejoin` | `() => Promise<JoinResult>` | iOS "rescan QR" path; joins again with the same `selfId`. A failure keeps the room, so it can be repeated. |
| `roster` | `() => readonly RosterEntry[]` | Sorted defensive copy (by `joinedAt`). |
| `self` | `() => SelfInfo` | `{ selfId, role, roomCode }`. |
| `hostId` | `() => PeerId` | The host's stable peer id (the star hub). On the HOST equals `self().selfId`; on a CONTROLLER it is the resolved host id (the `IntentFrame` target), `""` until the host channel is established. Used by `intentPlugin` to address the host. |
| `persistSnapshot` | `(snapshot: Snapshot, sSeq: number) => void` | HOST-ONLY seam called by `sync`; payload is opaque. |
| `recoveryPhase` | `() => RecoveryPhase` | A controller's phase, for reconnect UX. A host's phase stays `"stable"`, also on a reload. |
| `reentryRecord` | `() => HostReentryRecord \| null` | The record this load restored. `sync` reads it in `onInit`. `null` on a first load, on a controller and after `leave()`. |
| `onRoomEnded` | `(cb: () => void) => () => void` | `cb` runs when `leave()` finishes and when a failed first join is settled, whatever the phase. Not on a failed `rejoin`, which keeps the room. No event fires on these paths. `intent` registers once in `onInit`: live window retired, buffering off, buffer dropped. `sync` too: it resets for the next room. The list survives a `leave()`, and `app.stop()` clears it. |

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
| `transport.connect` rejects with anything else, a hub socket closed before its ack too | `{ ok: false, reason: "not-found" }` |
| Nothing within `reconnectTimeoutMs` | `{ ok: false, reason: "unreachable" }` |
| A newer `joinRoom` or `rejoin` started while this one was pending | `{ ok: false, reason: "unreachable" }` |

- **Over the cap, the host** sends `room-full` to that peer and disconnects it 250 ms later
  (`REFUSE_CLOSE_DELAY_MS`): a close in the same tick lost the frame in real Chromium. The roster and
  `room:peer-joined` do not change. The peer holds no seat during the delay, and a roster frame that reaches
  it then does nothing: `room-full` went first and settled the join. `teardownSession` clears the timer, so
  none survives `stop()` or `leave()`.
- **A failed `joinRoom`** leaves no room: `role` is `"none"`, `roomCode` is `""`, `hostId()` is `""`, recovery
  is `"stable"`, transport is closed. The promise resolves after the close finished, or after 1 s when the close
  hangs on a dead socket (`JOIN_CLOSE_WAIT_MS`), and `close()` keeps the wiring, so calling `joinRoom` again on the
  same app retries.
- **A lost `room-full` frame** ends as `unreachable` at the timeout. The state after it is the same. On
  `serverSignaling` at the default cap the hub refuses first, so no frame is needed.
- **A retry inside the delay** gets `full` at once. The `full` result removed the saved id, so the retry is a new
  peer. A reload that beat the frame comes back with the same id: the host replaces the record it still holds and
  refuses again.
- **A failed `rejoin`** (and the auto-rejoin of §5.4) keeps the room: `role`, `roomCode` and transport stay, so
  it can be repeated and a host that comes back later is still adopted. A failed auto-rejoin moves the phase to
  `"degraded"` only while it is not `"stable"`: a `leave()` or a host that came back during the rejoin ended the absence.
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

Only a broadcast makes a record: `sync` calls `persistSnapshot` after it broadcasts a dirty slice. A host
that never broadcast has nothing to resume. A reloaded host keeps the record it restored until a new one comes, and
every write to `localStorage` sets `savedAt` to now. So the age counts from when this host was last alive, and a lobby
that sits idle stays resumable.

A reload replays the record's reclaim token (`serverSignaling` only). When that connect fails, the hub evicted the room
for example, and the room is still this one, the host joins the same code again with no token and gets a new one. The
kept record takes the new token and is written at once, so the next reload of an idle room is not refused again, also
after a tab killed with no `visibilitychange`. The refusal fires no
`room:network-warning`: `rendezvous-unreachable` fires once, and only when the fresh join fails too.

## A phone reload

`joinRoom` keeps this tab's `selfId` in `sessionStorage`, key `<storageKeyPrefix>.self.<code>`. A reload in the same
tab loads it back. A second tab has its own. A duplicated tab copies `sessionStorage`, so both tabs hold one id and
the host sees one player: each join replaces the other. `leave()` and a `full` result remove it, and `app.stop()` keeps
it. With no usable `sessionStorage` the id lives as long as the app, so a reload is a new player.

When that id reaches the host again, it is a known id:

- `transport` replaces the old record silently: timer, channel, pc and warn keys go, and `onPeerLost` does not fire.
  There is no `room:peer-left`.
- `session` keeps the roster entry, `joinedAt` included, and admits it at the cap.
- `room:peer-joined` fires again, with no `room:peer-left` before it. `sync` sends the new replica its baseline on
  that event. A game that counts players on it must treat a known id as known.
- `intent` hears a new `run` on the next frame and clears its `lastApplied` mark for the id, because a new app counts
  `cSeq` from 0. A rejoin on the same app keeps the `run` and the mark.
- A phone away longer than `heartbeatTimeoutMs` was declared dead first: `room:peer-left` fired and the entry is gone.
  The same id then joins as a new entry, or gets `full`.
- A replacement whose handshake dies, past the retry cap or by leaving signaling, reports the peer lost: the entry goes,
  with one `room:peer-left`. An id that never reached the roster causes no event.

**The adapter decides whether the id reaches the host.**

| Adapter | A reloaded phone |
|---|---|
| `inMemory` | Same id, same slot. |
| `serverSignaling` | Same id, same slot. An older socket still open for the id is retired by the hub. |
| `publicRendezvous` (default) | Never the old slot. |

`publicRendezvous` never sends `selfId`. The roster is keyed by Trystero's peer id, and Trystero mints that id per
page load, so a reloaded phone is a new peer. If it reaches the host it takes a new slot. The old entry stays until the
heartbeat declares it dead, and a full room answers `full` until then. It reaches the host only while the host is in
signaling, and the host leaves signaling once a phone's channel connects (`transport/handlers.ts`). A phone that
reloads after that finds no host, and its join ends `unreachable`.

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
  lifecycle/            # code.ts, qr.ts, roster.ts, join.ts (settleJoin), self-id.ts
  recovery/             # types.ts, persistence.ts, hosttoken.ts, reentry.ts, buffer.ts, timeout.ts
  handlers.ts           # wire/peer-event handler factories (thin dispatchers)
  __tests__/            # unit/ + integration/ (inMemory adapter)
```
