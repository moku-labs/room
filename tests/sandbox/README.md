# Room sandbox

A minimal, runnable couch-multiplayer demo ("Tap Party") that composes the **public**
`roomPlugins.{stage,controller}` arrays through `@moku-labs/web`'s `createApp`, exactly as a real consumer
game would. It is both a manual playground and the target the Playwright e2e specs in
[`../e2e`](../e2e) drive.

> This is reference consumer code, not part of the published package. `bun run build` (tsdown) only bundles
> `src/index.ts` + `src/browser.ts`; the sandbox is never shipped.

## Run it

```bash
bun run sandbox          # builds the two entries and serves on http://localhost:5179
```

Then:

1. Open **http://localhost:5179/stage** on the shared screen (TV / laptop). It opens a room and shows a
   6-char code + a join QR.
2. Open **http://localhost:5179/controller** on each phone — scan the QR, or type the code — and tap.
3. Each tap is a `tap` intent → the host bumps that peer's cell in the authoritative `scores` slice and
   broadcasts → every device's read-only replica updates live.

### Signaling modes (URL flags)

| Flag | Effect |
|------|--------|
| *(none)* | **Default** — real WebRTC over `publicRendezvous` (Trystero, Nostr backbone). Works across devices and across browser tabs. |
| `?backbone=torrent` | Real WebRTC over the BitTorrent fallback backbone. |
| `?signaling=memory` | The in-process `inMemory()` bus. **Single JS context only** — handy for a deterministic boot smoke test on one page; it cannot bridge two tabs/devices. |

## The v1 GATE — iPhone-Safari ↔ Sony Bravia-7 interop (manual)

The automated e2e (`bun run test:e2e`) covers the deterministic boot/compose path and, when
`ROOM_E2E_LIVE=1` is set, an in-browser two-context real-WebRTC handshake. Neither replaces the **real
cross-device interop gate**, which must be run by hand on the target hardware before the transport
architecture is locked:

1. Serve the sandbox on a machine reachable from both devices (same LAN), e.g.
   `PORT=5179 bun run sandbox`, and note the LAN URL (e.g. `http://192.168.1.20:5179`). A secure
   context (`https://` or `localhost`) is required for `navigator.wakeLock` and some WebRTC paths — use a
   tunnel (e.g. a TLS dev proxy) if testing wake lock on the phone.
2. On the **Bravia-7** built-in browser, open `…/stage`. Confirm the room code + QR render.
3. On the **iPhone (Safari)**, open `…/controller`, scan the QR (or type the code), and tap.
4. Verify, end to end:
   - the controller's join resolves and the phone shows the game view;
   - taps move the host scoreboard within ~1 frame on the LAN (backbone never carries gameplay);
   - the host roster reflects join/leave;
   - **multi-controller**: a second phone joins and BOTH controllers' taps land (the star topology holds —
     controllers join `passive`, so they never mesh; verified against Trystero 0.25.2's `passive` join
     option);
   - reload the **stage** tab mid-game and confirm controllers surface `room:host-reconnecting` and either
     auto-recover or degrade to "rescan QR" on iOS (WebKit RTCPeerConnection reload bug).

Record the measured timings + any device quirks against the transport config knobs
(`heartbeatIntervalMs`, `openTimeoutMs`, `iceServers`) — these defaults are explicitly tunable per
real-device measurement (`src/plugins/transport/types.ts`).
