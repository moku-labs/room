# hub

> **Standard tier** plugin — Room's **opt-in operated signaling tier** (D21/D25), a
> [`@moku-labs/worker`](https://github.com/moku-labs/worker) plugin (`createPlugin` is imported from
> `@moku-labs/worker`) with no plugin `depends`; the hub reaches the DO + KV + ASSETS through the native
> Cloudflare `env`. Exported from **`@moku-labs/room/server`** (`src/server.ts`) — compose it into your own
> `@moku-labs/worker` app.

A DO-per-room WebSocket signaling hub: it brokers the WebRTC handshake + in-band discovery + host-reload
recovery over **WebSocket Hibernation**, then hands off to **WebRTC P2P gameplay** — the DO has **no relay
path** (D2 holds). Reached from the browser through Room's `Signaling` seam via the `serverSignaling(url)`
adapter; the `inMemory({ server: true })` simulator speaks the same `00-contracts.md` §1.3 protocol so
every path is testable before deploy.

## Responsibilities

1. **`hub` plugin** (`api.ts`) — a thin `handle(request, env, ctx)`: `Upgrade: websocket` → the
   per-room `Hub` DO (after a per-IP rate-limit check); `GET /api/ice` → the TURN-credential mint
   (`ice.ts` — see *Internet play* below); everything else → `env.ASSETS.fetch` (the built web
   client). One WS protocol (D21); `/api/ice` is the single HTTP endpoint, and it is an *upgrade*,
   never a dependency. The DO, KV, ASSETS, and TURN secrets are reached through the per-request
   native Cloudflare `env` (read directly off `env`, no plugin `depends`).
2. **`Hub` Durable Object** (`hub-do.ts`, a plain Cloudflare DO class — co-located, NOT a
   plugin, D6/I3) — Hibernation accept; a discriminated `ClientEnvelope.kind` switch
   (`join` / `reclaim` / `relay` — **no gameplay-relay case**); star-topology enforcement
   (passive↔passive never announced); the **join-window guard** (late `join` → close `1008`); the
   controller **cap** (`{kind:"full"}` + close); the host-reload **reclaim** handshake; and a
   safe-guarded **Alarm TTL** (reschedules while sockets live, `deleteAll()` only at zero).
3. **SQLite heavy state** (`sqlite.ts`) — the `sessions` roster (peer id + role + reclaim token + in-flight
   SDP/ICE), written inside the output-gate so a Hibernation wake mid-handshake never drops it. Socket
   attachments hold only `{peerId, role, openedAt}`.

## Public API (`app.hub`)

| Method | Signature | Notes |
|---|---|---|
| `handle` | `(request, env, ctx) => Promise<Response>` | The sole worker fetch handler. WS upgrade → per-room DO (`429` over the rate limit, `400` without a room code); `GET /api/ice` → the TURN-credential mint; else → `env.ASSETS`. |

## Configuration (`pluginConfigs.hub`)

| Field | Default | Notes |
|---|---|---|
| `doBinding` | `"ROOM_HUB"` | The per-room DO env binding (consumer `wrangler.jsonc`). |
| `doClassName` | `"Hub"` | The exported DO class. |
| `assetsBinding` | `"ASSETS"` | Static-assets binding serving the web client. |
| `rateLimit` | `{ joins: 30, windowSec: 60, kvBinding: "RATE_LIMIT" }` | Per-IP join rate limit (D24). |
| `ice` | `{ path: "/api/ice", keyIdBinding: "TURN_KEY_ID", apiTokenBinding: "TURN_KEY_API_TOKEN", rateLimit: { max: 30, windowSec: 60 } }` | The TURN-credential endpoint: route path, the two worker-secret names it mints with, and its own per-IP mint budget (same KV as `rateLimit.kvBinding`). |
| `joinWindowMs` | `10_000` | Reject a `join` arriving later than this after the socket opened (D24). |
| `roomTtlMs` | `1_800_000` | Idle TTL before the Alarm tears the room down (fires only at 0 sockets). |

## Protocol (`00-contracts.md` §1.3)

The client↔DO `ClientEnvelope` / `ServerEnvelope` unions are defined ONCE in `../transport/protocol` and
imported — never re-declared (D23). The DO and the `serverSignaling` adapter are the two ends of that
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

## Internet play (zero-config TURN)

The relay rung splits cleanly across the two frameworks — the app writes **zero** ICE code:

- **`GET /api/ice`** (`ice.ts`, this plugin) mints short-lived Cloudflare Realtime TURN credentials
  (4 h TTL, `Cache-Control: no-store`, per-IP rate-limited through the same `RATE_LIMIT` KV) when
  the deployment carries the two TURN secrets. Without them it answers a **quiet empty `200 {}`** —
  an expected state (every local dev run), never a red console line; the browser transport fails
  open onto its public-STUN default. Real failures stay loud: `405` / `429` / `502`.
- **The secrets** are provisioned by `@moku-labs/worker`'s **`turnPlugin`** (worker ≥ 0.16) — a
  first-class resource plugin, the same shape as `kvPlugin`: declare
  `pluginConfigs.turn = { relay: { name: "myapp-turn" } }` in the app's worker composition and
  every successful `deploy` ensures the key (idempotent secret check → key creation → bind; strictly
  fail-open + `--ci` safe — an impediment prints one instruction line and the deploy continues).
  The hub itself stays a pure runtime plugin: it only READS the secrets off `env`. You can also
  bind them by hand (`wrangler secret put TURN_KEY_ID / TURN_KEY_API_TOKEN`).
- **The browser side** is the transport's `iceServers: "auto"` default (see
  `../transport/README.md`): `serverSignaling` exposes the derived `iceEndpoint`, and `"auto"`
  fetches `/api/ice` lazily, in parallel with the signaling join.

## Deployment (app-side — D26)

Room ships **no `wrangler.jsonc`**. The consuming app composes `hubPlugin` into its own `@moku-labs/worker`
`createApp` — alongside `durableObjectsPlugin` (the `ROOM_HUB` DO + SQLite migration), `kvPlugin` (the
`RATE_LIMIT` namespace), and `deployPlugin`/`cliPlugin`, which **generate** the `wrangler.jsonc` (plus an
`ASSETS` binding for its built web client). Its `cloudflare/worker.ts` delegates `{ fetch }` to
`server.hub.handle` and re-exports the `Hub` DO class for the wrangler binding. For internet play,
add worker's `turnPlugin` + one `pluginConfigs.turn` line (see *Internet play* above).

## Testing

Unit + integration tests run under node/bun against a lightweight Hibernation/SQLite fake
(`__tests__/fakes.ts`) covering the full dispatch surface — join-window guard, cap, star topology, relay
opacity, reclaim, Alarm TTL, and `handle` routing. The DO's `fetch()` Hibernation accept (WebSocketPair /
`101` upgrade) and the real `workerd` + WebRTC path are covered by the Wave-4 Playwright-against-
`wrangler dev` sandbox run.
