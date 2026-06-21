# transport

Room's networking floor (Complex tier, Wave 1 — no Room dependencies). Owns three strictly-separated
planes:

1. **WebRTC `RTCPeerConnection` lifecycle** — one connection per peer in a star topology (host hub, up
   to 8 connections; controller = exactly one to the host). Drives offer/answer/ICE through the signaling
   seam; `restartIce()` on a transient drop.
2. **The typed `Wire` channel** — per-frame JSON serialization, chunking (~14 KiB) + reassembly,
   `bufferedAmount` backpressure (~64 KiB), a MANDATORY app-layer heartbeat (~2 s ping / ~6 s dead —
   WebKit bug 303052: `onclose` does not fire on iOS), and a ~3 s DataChannel-open timeout that retries
   the handshake (the iOS-Safari to Sony-Bravia interop mitigation).
3. **The general `Signaling` seam** — a DOM-free `adapter.ts` contract plus three adapters:
   `publicRendezvous()` (DEFAULT — Trystero v0.25.x, lazy-loaded), `inMemory()` (tests), and
   `serverSignaling(url)` (opt-in worker-backed, lazy-loaded). The server adapter opens one persistent
   WebSocket per room speaking the contracts §1.3 `ClientEnvelope`/`ServerEnvelope` protocol and returns a
   `persistent: true` session that survives post-ICE as the in-band discovery / host-reload-reclaim
   conduit; imminent room teardown surfaces as `room:network-warning { reason: "room-evicted" }` via the
   session's `onEvict` seam.

Emits exactly one Moku event: `room:network-warning { reason }` (`ice-failed` | `rendezvous-unreachable` |
`channel-closed` | `room-evicted`). **No gameplay traffic ever flows through Moku `emit`** — all
device-to-host frames ride the `Wire`.

## API

| Method | Description |
|---|---|
| `connect(opts)` | Joins the signaling room on demand (host active / controller passive). |
| `wire()` | Returns the stable typed `Wire` for send/broadcast/on. |
| `disconnect(peerId)` | Tears down one peer. |
| `peers()` | Read-only snapshot of connected peer ids. |
| `close()` | Closes all peers, stops the heartbeat, leaves the signaling session. |
| `onPeerConnected(cb)` | Registers the consumer fired when a peer's gameplay channel opens (host: a controller connected; controller: the host connected). Latest registration wins; returns an unsubscribe. Used by `sessionPlugin` to emit `room:peer-joined`. |
| `onPeerLost(cb)` | Registers the consumer fired when an established peer is lost via the heartbeat dead-peer path (§2.4 — NOT on clean teardown/`close()`/`disconnect()`). Latest registration wins; returns an unsubscribe. Used by `sessionPlugin` to emit `room:peer-left`. |

## Config

`signaling` (default `publicRendezvous()`), `iceServers` (default one public STUN; `[]` for LAN-only,
never TURN), `heartbeatIntervalMs` (2000), `heartbeatTimeoutMs` (6000), `openTimeoutMs` (3000),
`maxMessageBytes` (14336).

## Accepted hard-failure (D2)

Strict no-server P2P: no TURN, ever. **~15–30% of AP-isolated / symmetric-NAT / iOS-Private-Relay
networks hard-fail with no recovery path.** These surface `room:network-warning { reason: "ice-failed" }`
and do not recover. Room's design target is the home LAN (same room, shared AP).

## v1 GATE

The iOS-Safari to Sony-Bravia-7 (Android-TV Chromium) DataChannel interop on a home LAN with no TURN is
the make-or-break path. Validated via the repo-level `tests/e2e/` Playwright suite (D13).
