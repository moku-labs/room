/**
 * @file Public type surface for the controller facade — the CONTROLLER-role API (`ControllerApi`) a
 * phone-side couch-multiplayer game plugin composes against. Every shared shape (`Namespace`,
 * `JsonValue`, `RoomEvents`) is imported from their owning plugins (`../transport/protocol` for the wire/signaling protocol; `RoomEvents` from `../../config`) — never
 * re-declared here. The facade owns no state and no config, so there is no internal state/config type;
 * this file holds ONLY the public `ControllerApi` (the four engine delegations + the two iOS Screen Wake
 * Lock controls). `@moku-labs/web` infers `ctx` inline in `index.ts`, so no `PluginContext`/`PluginCtx`
 * type is imported (web does not export it, D1) and the api factory takes the four resolved engine APIs.
 * @see README.md
 */
import type { JsonValue, Namespace } from "../transport/protocol";

/**
 * The CONTROLLER-role public surface (phone side). A thin, typed facade over the four Room engines
 * (`transport` / `session` / `intent` / `sync`) — every method delegates to one resolved engine API.
 * Holds no state; presents the controller's coherent verb set (join / read / observe / intent) plus the
 * iOS Screen Wake Lock controls (D11). Returned by `createControllerApi`; consumed by a game plugin via
 * `ctx.require(controllerPlugin)` (or `app.controller`).
 *
 * @example
 * ```ts
 * const controller = app.controller; // or ctx.require(controllerPlugin) inside a game plugin
 * await controller.joinRoom("K7P2Q9");
 * const off = controller.on("round", round => render(round));
 * controller.intent("move", { dx: 1, dy: 0 });
 * ```
 */
export type ControllerApi = {
  /**
   * Joins the room identified by `code` as a PASSIVE peer — the controller waits to be offered to by the
   * authoritative host (star topology, contracts §6). Delegates to `sessionPlugin.joinRoom(code)`, which
   * performs the §1 rendezvous handshake, persists the phone-side `reconnectToken` (contracts §6
   * `RosterEntry`), and stays joined until `iceConnectionState === "connected"` (trickle ICE, §1.2). The
   * passive (controller-role) flag is set INTERNALLY by `sessionPlugin` (§1.1) — never a caller argument.
   * `joinRoom` resolves once the DataChannel to the host is live; it maps `sessionPlugin`'s discriminated
   * `JoinResult` to this contract — on `{ ok: false }` it THROWS an `Error` whose message is the `reason`
   * (`"full"` | `"not-found"` | `"unreachable"`), so the rejection is never silently dropped. A full room
   * is a session-API rejection, NOT a `room:network-warning` (contracts §6.2 — that enum is
   * connectivity-only).
   *
   * @param code - The 6-char room code from the TV's QR / join URL (contracts §6.2; `ROOM_CODE_LENGTH`).
   * @returns A promise resolving when the controller's channel to the host is connected.
   * @throws {Error} If the room is full (8-cap, contracts §6 `MAX_CONTROLLERS`), not found, or the
   *   rendezvous is unreachable — the `JoinResult.reason` becomes the thrown `Error.message`.
   * @example
   * ```ts
   * await controller.joinRoom("K7P2Q9");
   * ```
   */
  joinRoom(code: string): Promise<void>;

  /**
   * Reads the current value of one namespaced slice from the controller's READ-ONLY synced replica
   * (contracts §4). Delegates to `syncPlugin.read`. Returns a structurally-shared snapshot of that
   * namespace's cells; the controller MUST treat it as immutable (mutate authoritative state only by
   * sending an `intent`). Returns `undefined` if the namespace has no cells yet (e.g. before the first
   * `room:sync-ready`, contracts §3).
   *
   * @param ns - The namespace key to read (contracts §4.1 `Namespace`, e.g. `"scores"`, `"round"`).
   * @returns The namespace's `{ [key]: JsonValue }` map, or `undefined` if absent.
   * @example
   * ```ts
   * const scores = controller.read("scores"); // { p1: 12, p2: 9 } | undefined
   * ```
   */
  read(ns: Namespace): Readonly<Record<string, JsonValue>> | undefined;

  /**
   * Subscribes to changes of ONE namespace on the read-only replica (contracts §4). Delegates to
   * `syncPlugin.subscribe(ns, cb)`. The callback fires after each applied snapshot/delta touching `ns`
   * (sync applies deltas in `sSeq` order and requests a fresh snapshot on a detected gap, contracts §4.3 —
   * so the callback never observes out-of-order state). Fires once immediately with the current value if
   * the namespace is already populated.
   *
   * @param ns - The namespace to observe (contracts §4.1 `Namespace`).
   * @param cb - Invoked with the namespace's current `{ [key]: JsonValue }` map on every change.
   * @returns An unsubscribe function; call it to stop observing.
   * @example
   * ```ts
   * const off = controller.on("round", round => render(round));
   * // later: off();
   * ```
   */
  on(ns: Namespace, cb: (value: Readonly<Record<string, JsonValue>>) => void): () => void;

  /**
   * Sends one typed input to the authoritative host as an `IntentFrame` over the contracts §2 WIRE (NEVER
   * Moku `emit` — spec/07 §3, spec/11 §2.7). Delegates to `intentPlugin.intent(name, payload)`, which
   * stamps the monotonic per-controller `cSeq` (contracts §4.3, idempotent de-dup) and, while the host is
   * absent (contracts §5), buffers the intent timestamped for the later `recovery-flush` (contracts §5.3).
   * The payload is shape-checked correctness-only (D6 — no anti-cheat / rate-limit / HMAC). Fire-and-forget:
   * returns `void` (the host acks via synced state, not a reply).
   *
   * @param name - The registered intent name (the intent-contract key validated by `intentPlugin`).
   * @param payload - Plain-JSON intent payload (spec/11 §1.7); shape-checked by the intent contract (D6).
   * @example
   * ```ts
   * controller.intent("move", { dx: 1, dy: 0 });
   * controller.intent("buzz", {});
   * ```
   */
  intent(name: string, payload: JsonValue): void;

  /**
   * Requests a Screen Wake Lock (`navigator.wakeLock.request("screen")`, Safari 16.4+) so iOS does not
   * dim/lock the screen and SUSPEND the controller's DataChannel mid-session (D11 — there is no code-only
   * fix for the suspend; the wake lock is the mitigation). Idempotent: a second call while a sentinel is
   * already held is a no-op. If the platform lacks `navigator.wakeLock` (older iOS, or a non-secure
   * context) it resolves to `false` and is otherwise harmless — the session still runs, it is just
   * vulnerable to screen-lock suspension (which would later surface as
   * `room:network-warning { reason: "channel-closed" }` via the §2.4 heartbeat). Re-acquire on
   * `visibilitychange → visible` is the caller's choice; the facade exposes the primitive, the consumer
   * game decides the UX policy.
   *
   * @returns A promise resolving `true` if a wake lock is now held, `false` if unsupported/denied.
   * @throws {Error} Never — denial/absence resolves `false` rather than rejecting.
   * @example
   * ```ts
   * await controller.joinRoom("K7P2Q9");
   * await controller.requestWakeLock(); // keep the screen awake for the whole game
   * ```
   */
  requestWakeLock(): Promise<boolean>;

  /**
   * Releases the Screen Wake Lock acquired by {@link ControllerApi.requestWakeLock}, if held. Idempotent:
   * a no-op when no sentinel is held. Call when the controller intentionally backgrounds / leaves so the
   * device can sleep normally. (The OS also auto-releases the lock when the tab is hidden — this method is
   * for explicit teardown.)
   *
   * @returns A promise resolving once the sentinel is released (or immediately if none was held).
   * @example
   * ```ts
   * await controller.releaseWakeLock();
   * ```
   */
  releaseWakeLock(): Promise<void>;
};
