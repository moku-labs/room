# room-hub

> **Standard tier** plugin in the `@moku-labs/room` plugin pack — Room's **opt-in operated signaling
> tier** (D21/D25). `createPlugin` is imported from **`@moku-labs/worker`** (optional peer dependency),
> NOT `@moku-labs/web`/`@moku-labs/core`. `depends: [durableObjectsPlugin, kvPlugin, bindingsPlugin]`.
> Shipped through the **`@moku-labs/room/server`** sub-path (`src/server.ts`), never the web barrel (D26).

A DO-per-room WebSocket signaling hub: it brokers the WebRTC handshake + in-band discovery + host-reload
recovery over **WebSocket Hibernation**, then hands off to **WebRTC P2P gameplay** — the DO has **no relay
path** (D2 holds). Reached from the browser through Room's `Signaling` seam via the `serverSignaling(url)`
adapter; the `inMemory({ server: true })` simulator speaks the same `00-contracts.md` §1.3 protocol so
every path is testable before deploy.

## Responsibilities

1. **`roomHub` plugin** (`api.ts`) — a thin `handle(request, env, ctx)`: `Upgrade: websocket` → the
   per-room `RoomHub` DO (after a per-IP rate-limit check); everything else → `env.ASSETS.fetch` (the
   built web client). No HTTP/REST endpoints (D21 — default endpoint only, one WS protocol). Plus
   `deployManifest()` — the DO + rate-limit-KV descriptors the consumer's `@moku-labs/worker` deploy step
   reads.
2. **`RoomHub` Durable Object** (`room-hub-do.ts`, `defineDurableObject("RoomHub")` — co-located, NOT a
   plugin, D6/I3) — Hibernation accept; a discriminated `ClientEnvelope.kind` switch
   (`join` / `reclaim` / `relay` — **no gameplay-relay case**); star-topology enforcement
   (passive↔passive never announced); the **join-window guard** (late `join` → close `1008`); the
   controller **cap** (`{kind:"full"}` + close); the host-reload **reclaim** handshake; and a
   safe-guarded **Alarm TTL** (reschedules while sockets live, `deleteAll()` only at zero).
3. **SQLite heavy state** (`sqlite.ts`) — the `sessions` roster (peer id + role + reclaim token + in-flight
   SDP/ICE), written inside the output-gate so a Hibernation wake mid-handshake never drops it. Socket
   attachments hold only `{peerId, role, openedAt}`.

## Public API (`app.roomHub`)

| Method | Signature | Notes |
|---|---|---|
| `handle` | `(request, env, ctx) => Promise<Response>` | The sole worker fetch handler. WS upgrade → per-room DO (`429` over the rate limit, `400` without a room code); else → `env.ASSETS`. |
| `deployManifest` | `() => ResourceManifest[]` | The DO + rate-limit KV descriptors for the consumer's deploy pipeline. |

## Configuration (`pluginConfigs.roomHub`)

| Field | Default | Notes |
|---|---|---|
| `doBinding` | `"ROOM_HUB"` | The per-room DO env binding (consumer `wrangler.jsonc`). |
| `doClassName` | `"RoomHub"` | The exported DO class. |
| `assetsBinding` | `"ASSETS"` | Static-assets binding serving the web client. |
| `rateLimit` | `{ joins: 30, windowSec: 60, kvBinding: "RATE_LIMIT" }` | Per-IP join rate limit (D24). |
| `joinWindowMs` | `10_000` | Reject a `join` arriving later than this after the socket opened (D24). |
| `roomTtlMs` | `1_800_000` | Idle TTL before the Alarm tears the room down (fires only at 0 sockets). |

## Protocol (`00-contracts.md` §1.3)

The client↔DO `ClientEnvelope` / `ServerEnvelope` unions are defined ONCE in `../../contracts` and
imported — never re-declared (D16/D23). The DO and the `serverSignaling` adapter are the two ends of that
one protocol.

- **Client → DO:** `join` · `reclaim` · `relay` (carries an opaque `SignalMsg` — the DO never inspects it).
- **DO → client:** `join-ack {peers, reclaimToken}` · `peer-arrived` · `peer-left` · `reclaim-ack {peers}`
  · `relay {from, msg}` · `full` · `evict` · `error {code, message}`.

### Host-reload reclaim (end-to-end)

`join-ack` issues a `reclaimToken`; `session` persists it in the `HostReentryRecord` (read via
`transport.reclaimToken()`). On a host reload, `session` replays it through `ConnectOpts.reclaimToken`, the
`serverSignaling` adapter sends `{kind:"reclaim"}` instead of `{kind:"join"}`, and the warm DO re-binds the
host under its new `selfId` (keeping the same token), replies `reclaim-ack` with the live controllers, and
re-announces the host so controllers re-handshake — the room survives the reload instead of opening fresh.

## Events

**None of its own.** The worker has no Room event bus. The only Room event the server path influences is
`room:network-warning {reason:"room-evicted"}`, emitted **browser-side** by the `serverSignaling` adapter on
receipt of `{kind:"evict"}` — never by this plugin.

## Deployment (app-side — D26)

Room ships **no `wrangler.jsonc`**. The consuming app writes its own — declaring the `ROOM_HUB` (DO +
SQLite migration), `RATE_LIMIT` (KV), and `ASSETS` (its built web client) bindings, and pointing `main` at
`@moku-labs/room/server` (or a tiny local entry that re-exports it). `deployManifest()` describes the DO +
KV so the deploy step can assemble that config.

## Testing

Unit + integration tests run under node/bun against a lightweight Hibernation/SQLite fake
(`__tests__/fakes.ts`) covering the full dispatch surface — join-window guard, cap, star topology, relay
opacity, reclaim, Alarm TTL, and `handle` routing. The DO's `fetch()` Hibernation accept (WebSocketPair /
`101` upgrade) and the real `workerd` + WebRTC path are covered by the Wave-4 Playwright-against-
`wrangler dev` sandbox run.
