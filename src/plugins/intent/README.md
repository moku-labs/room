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
   per-controller `cSeq`, wraps an `IntentFrame`, and hands it to the transport `Wire.send` to the single
   host. This traffic NEVER flows through Moku `emit` — `emit` is reserved for the five coarse `room:*`
   lifecycle events, of which `intentPlugin` declares and emits **none**.
3. **Idempotency + reconnect buffering.** On the host, `lastApplied[peerId]` drops any inbound
   `cSeq <= lastApplied[peerId]` (D4) so a reconnect/flush replay never double-applies. On the controller,
   during a host absence every `intent()` is buffered as a timestamped queue entry; `sessionPlugin`'s
   recovery state machine drains it via `drainBuffer()` into a single `RecoveryFlushFrame`. The buffer is
   `bufferCap`-capped + `bufferMaxAgeMs`-pruned (lossy is acceptable for high-frequency analog intents).

## Role-agnostic

A single `intentPlugin` instance serves both roles (D5). The host calls `register` / `onIntent`; the
controller calls `intent`; both share `setBuffering` / `drainBuffer` / `bufferedCount`. Which half a
consumer reaches is a function of which facade (`stagePlugin` vs `controllerPlugin`) re-exposes which
methods — nothing is role-flagged at construction.

## API

| Method | Role | Purpose |
|---|---|---|
| `register(name, schema)` | host | Declare an intent kind + correctness-only shape-check. |
| `onIntent(name, handler)` | host | Subscribe to validated, de-duplicated intents; returns an unsubscribe. |
| `intent(name, payload)` | controller | Stamp `cSeq`, send (or buffer) one typed intent over the Wire. |
| `setBuffering(on)` | recovery seam | Toggle controller buffering during a host absence. |
| `drainBuffer()` | recovery seam | Atomically return + clear the pruned, `ts`-ordered buffer. |
| `bufferedCount()` | recovery seam | Read the current buffered-intent count for reconnect UX. |

## Config

| Key | Type | Default | Description |
|---|---|---|---|
| `bufferCap` | `number` | `256` | Max buffered intents during a host absence; FIFO-drop oldest past the cap. |
| `bufferMaxAgeMs` | `number` | `10_000` | Max age (ms) a buffered intent is kept before prune; `>=` the ~10 s reconnect timeout. |

## Dependencies

- `transportPlugin` — the `Wire` (`send` to route a live intent to the host; `on` to receive inbound
  `t:"intent"` frames on the host receive path).
- `sessionPlugin` — resolves the single host `PeerId` for `Wire.send`, and is the **caller** for the
  buffer seam (`setBuffering` / `drainBuffer`) during the `room:host-reconnecting` window. `intent` does
  NOT depend on `sync` (D5) — that keeps it buildable + unit-testable in parallel with `sync`.

## Non-goals

- **No events.** Zero Moku events declared or emitted.
- **No hooks.** The host receive path is the transport `Wire.on` frame dispatch, not a Moku hook — so
  there is no `handlers.ts`.
- **No anti-cheat / rate-limit / HMAC.** Shape-checking is correctness-only (D6, trusted threat model).
- **No `onStart`/`onStop`.** No owned resource; the `Wire.on` callback is subsumed by `transport.onStop`.
