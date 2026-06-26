# controller

[![tier: Standard](https://img.shields.io/badge/tier-Standard-blue)](#) **CONTROLLER-role facade**

The thin **CONTROLLER-role facade** (phone side) a couch-multiplayer game plugin composes against to
join a room, observe the read-only synced replica, and send typed intents to the authoritative host. It
owns no state and contains no business logic: every method delegates to one of the four resolved engine
APIs it depends on (`transport`, `session`, `intent`, `sync`). It re-declares all five `room:*`
lifecycle events so a game plugin with `depends: [controllerPlugin]` gets the complete, typed hook
surface in one edge (WARN-2 — event visibility is not transitive at the type level: spec/07 §5,
spec/14 §7); it adds no forwarding hooks, since Moku's global event bus already delivers the engines'
emits to a `depends: [controllerPlugin]` consumer directly (D19). The one
browser resource it touches directly is the iOS Screen Wake Lock (Safari 16.4+), exposed as an API method
(not a lifecycle hook) so the consuming game owns the UX policy (D11). The four engines are core defaults; add the controller facade via
`createApp({ plugins: [controllerPlugin] })`.

## Config

None. All tunables live on the engines (transport / session / intent / sync) and are set in
`pluginConfigs` by the consuming app. Wake-lock behaviour is opt-in via the `requestWakeLock()` API, not
a config flag, so there is nothing to default.

## API

### `joinRoom(code: string): Promise<void>`

Joins the room identified by `code` as a PASSIVE peer (the controller waits to be offered to by the host
— star topology, contracts §6). Delegates to `session.joinRoom(code)`, which runs the contracts §1
rendezvous handshake, persists the phone-side `reconnectToken` (contracts §6), and stays joined until
the channel is `connected`. The passive (controller-role) flag is set INTERNALLY by `sessionPlugin` — it
is never a caller argument. Maps `session`'s discriminated `JoinResult` to this contract: resolves once
the DataChannel to the host is live, or **throws** an `Error` whose message is the `reason`
(`"full"` | `"not-found"` | `"unreachable"`) so the rejection is never silently dropped (a full room is
a session-API rejection, NOT a `room:network-warning` — contracts §6.2).

### `read(ns: Namespace): Readonly<Record<string, JsonValue>> | undefined`

Reads the current value of one namespaced slice from the controller's READ-ONLY synced replica
(contracts §4). Delegates to `sync.read(ns)`. Returns an immutable snapshot of that namespace's cells,
or `undefined` if the namespace has no cells yet (e.g. before the first `room:sync-ready`). Controllers
never mutate authoritative state — they change it by sending an `intent`.

### `on(ns: Namespace, cb: (value: Readonly<Record<string, JsonValue>>) => void): () => void`

Subscribes to changes of ONE namespace on the read-only replica (contracts §4). Delegates to
`sync.subscribe(ns, cb)`. The callback fires after each applied snapshot/delta touching `ns` (sync
applies deltas in `sSeq` order — never out of order, contracts §4.3) and once immediately with the
current value if the namespace is already populated. Returns an unsubscribe function.

### `intent(name: string, payload: JsonValue): void`

Sends one typed input to the authoritative host as an `IntentFrame` over the contracts §2 WIRE (NEVER
Moku `emit` — spec/07 §3, spec/11 §2.7). Delegates to `intent.intent(name, payload)`, which stamps the
monotonic per-controller `cSeq` (contracts §4.3, idempotent de-dup) and, while the host is absent,
buffers the intent for the later recovery flush (contracts §5.3). Payload is shape-checked
correctness-only (D6 — no anti-cheat). Fire-and-forget: returns `void` (the host acks via synced state).

### `requestWakeLock(): Promise<boolean>`

Requests a Screen Wake Lock (`navigator.wakeLock.request("screen")`, Safari 16.4+) so iOS does not
dim/lock the screen and suspend the controller's DataChannel mid-session (D11). Facade-owned (the one
browser resource it touches directly). Idempotent: a second call while a sentinel is held is a no-op.
Feature-detected — on a platform without `navigator.wakeLock`, or on denial, resolves `false` and never
throws. Re-acquire on `visibilitychange → visible` is the consumer's UX choice.

### `releaseWakeLock(): Promise<void>`

Releases the Screen Wake Lock acquired by `requestWakeLock()`, if held. Idempotent — a no-op when no
sentinel is held. The symmetric teardown to `requestWakeLock()` (the OS also auto-releases the lock when
the tab is hidden/closed, so there is no leaked-handle hazard if the tab is killed rather than stopped).

## Events

Re-declared from `00-contracts.md` §3.1 (identical payloads) for type visibility, and delivered
unchanged from the owning engine via Moku's global event bus, so a `depends: [controllerPlugin]` game
plugin receives the complete lifecycle surface (WARN-2). The facade owns none of these originally — it
re-declares them (for compile-time visibility) because event visibility is not transitive at the type
level (spec/07 §5); it installs no forwarding hooks, since the global bus already delivers each engine's
emit to the consumer (D19). Coarse lifecycle only — no gameplay payload ever flows through `emit`
(spec/07 §3).

| Event | Payload | Owner (re-declared; bus-delivered) | Description |
|-------|---------|---------------------------------|-------------|
| `room:peer-joined` | `{ peerId: PeerId }` | `session` | A controller's DataChannel reached `connected` and joined the roster (contracts §3, §6). |
| `room:peer-left` | `{ peerId: PeerId }` | `session` | A controller left or was declared dead by the heartbeat and left the roster (contracts §2.4, §3). |
| `room:host-reconnecting` | `Record<string, never>` (`{}`) | `session` | Host tab reloaded; client-side recovery is in flight (contracts §5). Show reconnecting UX. |
| `room:sync-ready` | `Record<string, never>` (`{}`) | `sync` | First full snapshot applied; the read-only replica is now readable (contracts §4). |
| `room:network-warning` | `{ reason: "ice-failed" \| "rendezvous-unreachable" \| "channel-closed" }` | `transport` | A connectivity hard-failure surfaced for failure UX (contracts §3.1, D2). |

## Dependencies

| Plugin | Role | Reason |
|--------|------|--------|
| `transportPlugin` | visibility-only | Listed in `depends` solely so `transport`'s `room:network-warning` is mergeable for re-declaration (WARN-2). No method is ever `require`d. |
| `sessionPlugin` | delegation target | `joinRoom()` delegates here; owns the rendezvous join + passive flag + reconnect-token slot (contracts §1, §6) + recovery (§5); source of `room:peer-joined`/`-left`/`host-reconnecting`. |
| `intentPlugin` | delegation target | `intent()` delegates here; owns the `IntentFrame` wire send, `cSeq` stamping, and host-absence buffering (contracts §4.3, §5.3). |
| `syncPlugin` | delegation target | `read()` / `on()` delegate here; owns the read-only replica (contracts §4); source of `room:sync-ready`. |

## Usage

A game plugin adds `controllerPlugin`, drives the controller through `app.controller.*`, and hooks the
`room:*` lifecycle by declaring `depends: [controllerPlugin]` (which is how all five events become
visible — WARN-2):

```typescript
import { createApp, createPlugin, controllerPlugin } from "@moku-labs/room";

// A couch-multiplayer game plugin that drives the phone-side controller.
const padGame = createPlugin("padGame", {
  // depends on the facade — this is what makes the five room:* events visible (WARN-2).
  depends: [controllerPlugin],

  // Hook the re-declared lifecycle events (bus-delivered). Payloads come from contracts §3.1.
  hooks: ctx => ({
    "room:sync-ready": () => ctx.log.info("replica is readable"),
    "room:host-reconnecting": () => ctx.log.info("host reloading — showing reconnecting UX"),
    "room:network-warning": ({ reason }) => ctx.log.warn(`network: ${reason}`)
  })
});

// The four engines are core defaults; add the controller facade, then the game plugin.
const app = createApp({
  plugins: [controllerPlugin, padGame]
});

await app.start();

// Join the room (code from scanning the TV's QR), then keep the screen awake for the session.
await app.controller.joinRoom("K7P2Q9"); // throws Error("full" | "not-found" | "unreachable") on failure
await app.controller.requestWakeLock(); // true if held; false if unsupported/denied — never throws

// Observe the read-only synced replica.
const off = app.controller.on("round", round => render(round));

// Send a typed input to the authoritative host over the §2 wire (never emit).
app.controller.intent("move", { dx: 1, dy: 0 });

// Teardown.
off();
await app.controller.releaseWakeLock();
```
