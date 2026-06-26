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
   SAME room code; controller intent buffering + flush/reconcile; a ~10 s reconnect timeout; the iOS
   "rescan the QR to rejoin" degradation.
4. **Transport event handling** (`handlers.ts`) — translates transport peer/wire signals into roster
   mutations, the three `room:*` emissions, and recovery-frame processing.

## Public API (`app.session`)

| Method | Signature | Notes |
|---|---|---|
| `createRoom` | `() => RoomDescriptor` | HOST. Returns `{ code, joinUrl, qr, hostToken }` SYNCHRONOUSLY (no `Promise`). `qr` is ALWAYS `null` here (QR generation is async) — use `qr()`. Throws if already in a room. |
| `qr` | `() => Promise<QrMatrix \| null>` | HOST. Async companion to `createRoom` — builds the join-QR matrix for the open room (the `qrcode` encoder is lazy-imported host-only). `null` when `generateQr` is `false` or no room is open. Encodes the join URL ONLY — never SDP/ICE. |
| `joinRoom` | `(code: string) => Promise<JoinResult>` | CONTROLLER (passive set internally). `{ ok:false, reason:"full"\|"not-found"\|"unreachable" }` on failure. |
| `leave` | `() => Promise<void>` | Idempotent. |
| `rejoin` | `() => Promise<JoinResult>` | iOS "rescan QR" path; re-uses the persisted `reconnectToken`. |
| `roster` | `() => readonly RosterEntry[]` | Sorted defensive copy (by `joinedAt`). |
| `self` | `() => SelfInfo` | `{ selfId, role, roomCode }`. |
| `hostId` | `() => PeerId` | The host's stable peer id (the star hub). On the HOST equals `self().selfId`; on a CONTROLLER it is the resolved host id (the `IntentFrame` target), `""` until the host channel is established. Used by `intentPlugin` to address the host. |
| `persistSnapshot` | `(snapshot: Snapshot, sSeq: number) => void` | HOST-ONLY seam called by `sync`; payload is opaque. |
| `recoveryPhase` | `() => RecoveryPhase` | Poll this on the reload path (see below). |

## Events (Moku `emit` plane — coarse lifecycle ONLY)

Declares + emits THREE of the five `room:*` events: `room:peer-joined`, `room:peer-left`,
`room:host-reconnecting`. It does NOT declare `room:sync-ready` (owned by `sync`) or
`room:network-warning` (owned by `transport`) — the `stage`/`controller` facades re-declare all five.

**No wire/DataChannel traffic flows through `emit`.** Recovery frames + roster broadcasts ride
`transport`'s `Wire`; `emit` carries only the three coarse `room:*` events.

## Reload-path timing — consumers MUST poll, not await the event

`room:host-reconnecting` is emitted during `session` `onInit` (plugin #2), which runs synchronously
during `createApp` BEFORE downstream consumer handlers are registered.
On the reload path the event therefore fires into a hook surface that does not yet exist. Consumers on
the reload path MUST poll `app.session.recoveryPhase()` in their own `onInit`/`onStart` (a non-`"stable"`
phase means recovery is in flight) rather than rely on the event. The event remains useful for the
steady-state (non-reload) host-reload detection.

## Lossy intent buffering (acceptable for v1)

While the host is absent, controllers buffer timestamped intents. The buffer is a ring (cap
`intentBufferMax`, oldest dropped first) and entries older than `intentBufferMaxAgeMs` are discarded on
flush. This is LOSSY by design for high-frequency analog intents — acceptable for the v1 party-game
target. Do NOT assume exactly-once intent delivery across a host reload.

## Host crash vs reload

A host *reload* is recoverable. A host *crash* is an UNMITIGATED v1 hard-failure (steering boundary; host
migration deferred to v2). `recovery/` does not pretend to recover a crash.

## Configuration

All fields default; override via `createApp({ pluginConfigs: { session: { ... } } })`. Defaults encode
the D11 / contracts §5 constants: `joinUrlBase:""`, `generateQr:true`, `maxControllers:8`,
`snapshotDebounceMs:500`, `reconnectTimeoutMs:10_000`, `intentBufferMax:256`, `intentBufferMaxAgeMs:8000`,
`storageKeyPrefix:"moku.room"`, `codeLength:6`.

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
  lifecycle/            # code.ts, qr.ts, roster.ts
  recovery/             # types.ts, persistence.ts, hosttoken.ts, reentry.ts, buffer.ts, timeout.ts
  handlers.ts           # wire/peer-event handler factories (thin dispatchers)
  __tests__/            # unit/ + integration/ (inMemory adapter)
```
