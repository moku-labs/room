# intent

> **Standard tier.** Controller → host typed-input contract — the narrow, independently testable slice
> extracted out of `syncPlugin` (D5) so the sync engine stays within Complex and the intent surface can
> be unit-tested in isolation.

## Responsibilities

1. **Typed intent registration (host side).** `register(name, schema)` declares a correctness-only typed
   shape (`IntentSchema`); `onIntent(name, handler)` subscribes to validated, in-order, de-duplicated
   intents. An inbound `IntentFrame` whose `name` was never registered, or whose `payload` fails the
   schema shape-check, is **dropped** (D6 — correctness, not security; no error channel back, no penalty).
2. **Controller → host routing over the Wire (NOT emit).** `intent(name, payload)` stamps a monotonic
   per-controller `cSeq`, wraps an `IntentFrame`, and hands it to the at-least-once delivery tracker
   toward the single host. This traffic NEVER flows through Moku `emit` — `emit` is reserved for the seven
   coarse `room:*` lifecycle events, of which `intentPlugin` declares and emits exactly **one**
   (`room:intent-undeliverable`, the terminal delivery verdict below).
3. **At-least-once live delivery (§4.3).** The wire is at-most-once (`Wire.send` silently discards on a
   closed/half-open channel), so the host **receipt-acks** every received intent frame (`intent-ack` —
   fresh AND duplicate, before the registration/shape/de-dup pipeline) and the controller retransmits the
   SAME frame (same `cSeq` — safe under the de-dup) on a doubling backoff until acked. Past the bounded
   budget the wire is declared dead: the in-flight intent and everything queued behind it drop, one
   `room:intent-undeliverable` each. The window is deliberately **stop-and-wait** — one unacked frame in
   flight, later intents queue behind it in `cSeq` order — because the host's high-water-mark de-dup
   would silently eat a retransmitted older frame forever if a newer `cSeq` ever applied first. Cost: one
   wire RTT between consecutive live intents (imperceptible at couch-LAN RTTs against human input rates).
4. **Idempotency + reconnect buffering.** On the host, `lastApplied[peerId]` drops any inbound
   `cSeq <= lastApplied[peerId]` (D4) so a retransmit/reconnect/flush replay never double-applies.
   Every frame carries the sending app's `run`, one random id per app, minted at its first `intent()`. A `run` that differs from the peer's last one
   clears that peer's mark before the de-dup: a phone back on a known id is a new app, and its `cSeq` starts at 0 again.
   The same `run` keeps the mark, so a same-app `rejoin` that resends a frame the host applied but never acked applies
   it once. A frame with no `run` counts as run `""`. A frame from a peer with no seat in `session.roster()`, such as a
   refused phone inside the close delay, is acked and dropped, and leaves no mark. On the
   controller, during a host absence every `intent()` is buffered as a timestamped queue entry — and
   `setBuffering(true)` first **retires the live delivery window into that buffer** (the §5 recovery
   contract subsumes the retransmit contract during a known host absence; no `intent-undeliverable`
   fires for retired frames). The buffer is `bufferCap`-capped + `bufferMaxAgeMs`-pruned (lossy is
   acceptable for high-frequency analog intents).
5. **Following the host's absence (`recovery.ts`).** Two hooks, both guarded on the session role `controller`
   (the host also emits `room:host-reconnecting`, on its own reload). `room:host-reconnecting` turns buffering
   on. `room:host-back` turns it off, drains the buffer and sends each frame through the delivery tracker with
   its own `cSeq`, in `cSeq` order, so the stop-and-wait rule above still holds. A restarted host has an empty
   `lastApplied`, so a frame the old host applied but never acked applies twice. When the room itself ends
   (`session.onRoomEnded`: a `leave()` or a failed first join), `endRoom` retires the live window, turns buffering off
   and drops the buffer, so no frame of that room reaches the next one and the next room's intents go live. No event
   fires for that.

## Role-agnostic

A single `intentPlugin` instance serves both roles (D5). The host calls `register` / `onIntent` and its
receive path sends the `intent-ack` receipts; the controller calls `intent` and its receive path routes
inbound receipts to the delivery tracker; both share `setBuffering` / `drainBuffer` / `bufferedCount`.
Which half a consumer reaches is a function of which facade (`stagePlugin` vs `controllerPlugin`)
re-exposes which methods — nothing is role-flagged at construction.

## API

| Method | Role | Purpose |
|---|---|---|
| `register(name, schema)` | host | Declare an intent kind + correctness-only shape-check. |
| `onIntent(name, handler)` | host | Subscribe to validated, de-duplicated intents; returns an unsubscribe. Throws on an unregistered name. |
| `intent(name, payload)` | controller | Stamp `cSeq`, deliver at-least-once (or buffer) one typed intent over the Wire. |
| `setBuffering(on)` | recovery seam | Toggle controller buffering; ON retires the live delivery window into the buffer. The plugin's hooks call the same code on a host absence. |
| `drainBuffer()` | recovery seam | Atomically return + clear the pruned, `ts`-ordered buffer. |
| `bufferedCount()` | recovery seam | Read the current buffered-intent count for reconnect UX. |

## Events

| Event | Payload | Meaning |
|---|---|---|
| `room:intent-undeliverable` | `{ name, cSeq }` | A live intent exhausted its bounded retransmit budget with no wire-level receipt — the wire is dead for this controller's intent stream, and every intent queued behind the dead one drops with its own event. Fires only for LIVE sends; buffered intents follow the §5 recovery contract instead. Exhaustion is a verdict, not a latch — a later `intent()` starts a fresh tracked cycle. |

## Config

| Key | Type | Default | Description |
|---|---|---|---|
| `bufferCap` | `number` | `256` | Max buffered intents during a host absence (FIFO-drop oldest past the cap). Doubles as the live send-queue cap — past it the oldest QUEUED intent drops with its own `room:intent-undeliverable`. |
| `bufferMaxAgeMs` | `number` | `10_000` | Max age (ms) a buffered intent is kept before prune; `>=` the ~10 s reconnect timeout. |
| `ackTimeoutMs` | `number` | `1000` | Ms an unacked live intent waits before its first retransmit; the wait doubles per attempt (1×, 2×, 4×, …). |
| `maxRetransmits` | `number` | `3` | Bounded re-sends of the SAME frame before the terminal `room:intent-undeliverable` (`0` = track + signal, never re-send). Total silence budget ≈ 15 s at the defaults — spans the ~10 s heartbeat dead-peer window. |

## Dependencies

- `transportPlugin` — the `Wire` (`send` to route a live intent to the host and to return `intent-ack`
  receipts; `on` to receive inbound `t:"intent"` / `t:"intent-ack"` frames).
- `sessionPlugin` — resolves the single host `PeerId` for `Wire.send` (re-resolved on every retransmit
  attempt, so a pre-join send heals once the host is known), gives the role the hooks are guarded on and the
  `roster()` the seat check reads, and emits `room:host-reconnecting` + `room:host-back`, which drive the buffer, and calls back through
  `onRoomEnded` when the room ends. `intent` does NOT depend
  on `sync` (D5) — that keeps it buildable + unit-testable in parallel with `sync`.

## Non-goals

- **No gameplay on emit.** The one declared event (`room:intent-undeliverable`) is a coarse lifecycle
  verdict; intents themselves NEVER flow through Moku `emit`.
- **No hook on the receive path.** It is the transport `Wire.on` frame dispatch, so there is no
  `handlers.ts`. The only hooks are the two `room:host-*` ones in `recovery.ts`.
- **No anti-cheat / rate-limit / HMAC.** Shape-checking is correctness-only (D6, trusted threat model).
- **No application-level acks.** The `intent-ack` receipt confirms the frame reached the host's intent
  engine, NOT that a handler ran — an unregistered or shape-rejected intent is still acked (its silent
  drop is the D6 host-authority contract, not a wire failure).

## Resources

`onStop` exists for exactly one resource: the delivery tracker's retransmit timer, stopped through the
plugin's own state (mirroring `syncPlugin`'s throttle-loop teardown). The `Wire.on`
callback itself is still subsumed by `transport.onStop`.
