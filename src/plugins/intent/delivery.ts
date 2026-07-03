/**
 * @file The controller-side at-least-once delivery tracker for LIVE `IntentFrame` sends (§4.3).
 * @see README.md
 *
 * Built EXACTLY ONCE per app by `createIntentApi` over THIS app's frozen `config` + transport `Wire`,
 * then shared via `state.delivery` (D14) so the receive path (inbound `intent-ack` receipts) and
 * `onStop` (timer teardown) reach the SAME instance. The wire is at-most-once (`Wire.send` silently
 * discards on a closed/half-open channel), so the tracker retransmits the SAME frame — same `cSeq`,
 * safe under the host's high-water de-dup — until the host's wire-level receipt arrives or the bounded
 * budget exhausts (`room:intent-undeliverable`).
 *
 * The window is deliberately STOP-AND-WAIT (one unacked frame in flight; later intents queue behind it
 * in `cSeq` order). This is forced by the host's `lastApplied` HIGH-WATER-MARK de-dup: if a newer
 * `cSeq` were ever allowed to apply first, a retransmitted older frame would arrive `<= lastApplied`
 * and be silently eaten forever — positively unhealable. Serializing transmissions makes the loop
 * airtight: the host's mark can never pass an unreceipted frame, so every tracked intent either applies
 * exactly once or is explicitly reported dead. Cost: one wire RTT between consecutive live intents
 * (imperceptible at couch-LAN RTTs against human input rates).
 */
import type { IntentFrame, PeerId, Wire } from "../transport/protocol";
import type { IntentConfig, IntentDelivery } from "./types";

/** Error message prefix for [room] formatted errors (spec/11 Part 3; matches the `room:` event namespace). */
const ERROR_PREFIX = "[room]";

/**
 * Multiplier applied to `ackTimeoutMs` after each retransmit (waits of 1×, 2×, 4×, … the base), so a
 * congested-but-alive wire is probed progressively less aggressively while the total silence budget
 * stays bounded at `ackTimeoutMs * (2^(maxRetransmits+1) - 1)`.
 */
const RETRANSMIT_BACKOFF_FACTOR = 2;

/**
 * The narrowed `emit` the tracker needs — fires the single event this plugin owns
 * (`room:intent-undeliverable`, contracts section 3.1). The wiring harness binds it inline in
 * `index.ts` as `payload => ctx.emit("room:intent-undeliverable", payload)`, so the tracker never
 * imports the framework `EmitFunction` (conventions section 3).
 */
type UndeliverableEmit = (payload: { name: string; cSeq: number }) => void;

/**
 * Builds the ONE per-app {@link IntentDelivery} tracker over this app's frozen `config`, transport
 * `wire`, and a host-id resolver. A LOCAL factory bound to the passed pieces — NOT a module-level
 * singleton — so each composed app (the `inMemory` stage + N controllers) tracks its own window and its
 * own retransmit timer. `getHostId` is re-resolved on EVERY (re)transmission, so frames sent before the
 * host's `PeerId` was known (resolver returns `""` pre-join — `Wire.send` to it is a silent no-op) heal
 * on the first retransmit after join, and a host id that changes across a reconnect is picked up.
 *
 * Validates the retransmit knobs eagerly (the `api` lifecycle phase) with `[room]`-formatted errors.
 *
 * @param config - This app's frozen intent config (`ackTimeoutMs`, `maxRetransmits`, `bufferCap`).
 * @param wire - The transport `Wire` used to (re)send tracked frames to the host.
 * @param getHostId - Resolver for the single host `PeerId` — re-resolved per transmission attempt.
 * @param emitUndeliverable - Narrowed emit for the terminal `room:intent-undeliverable` event.
 * @returns The per-app {@link IntentDelivery} tracker (send / onAck / retire / stop).
 * @example
 * ```ts
 * const delivery = createIntentDelivery(config, wire, () => session.hostId(), payload =>
 *   emit("room:intent-undeliverable", payload)
 * );
 * delivery.send({ t: "intent", name: "move", payload: { dx: 1 }, cSeq: 0 });
 * delivery.onAck(0); // host receipt — window open for the next frame
 * ```
 */
export function createIntentDelivery(
  config: Readonly<IntentConfig>,
  wire: Wire,
  getHostId: () => PeerId,
  emitUndeliverable: UndeliverableEmit
): IntentDelivery {
  // Eager knob validation — the factory runs in the api phase, so a bad config fails app init loudly.
  if (!Number.isFinite(config.ackTimeoutMs) || config.ackTimeoutMs < 1) {
    throw new Error(
      `${ERROR_PREFIX} intent.ackTimeoutMs must be >= 1 (got ${config.ackTimeoutMs}).\n  Set a positive value in pluginConfigs.intent.ackTimeoutMs.`
    );
  }
  if (!Number.isInteger(config.maxRetransmits) || config.maxRetransmits < 0) {
    throw new Error(
      `${ERROR_PREFIX} intent.maxRetransmits must be a non-negative integer (got ${config.maxRetransmits}).\n  Set a value >= 0 in pluginConfigs.intent.maxRetransmits.`
    );
  }

  // The stop-and-wait window: ONE unacked in-flight frame + the FIFO queue behind it. Closure-scope
  // (NOT in IntentState) so the state stays plain data; everything reaches the tracker via the single
  // `state.delivery` handle.
  let inFlight: { frame: IntentFrame; retransmitsSpent: number } | null = null;
  const queue: IntentFrame[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Cancels the armed retransmit timer, if any. Idempotent.
   *
   * @example
   * ```ts
   * clearTimer(); // safe whether or not a timeout is armed
   * ```
   */
  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  /**
   * (Re)arms the single retransmit timer for the in-flight frame.
   *
   * @param delayMs - Milliseconds until the next retransmit attempt fires.
   * @example
   * ```ts
   * armTimer(config.ackTimeoutMs * 2); // second wait of the doubling backoff
   * ```
   */
  function armTimer(delayMs: number): void {
    clearTimer();
    timer = setTimeout(handleAckTimeout, delayMs);
  }

  /**
   * Puts a frame in flight: transmits it to the (re-resolved) host and arms the base ack timeout.
   *
   * @param frame - The frame taking the window.
   * @example
   * ```ts
   * transmit(nextQueued); // promoted after the previous frame's receipt
   * ```
   */
  function transmit(frame: IntentFrame): void {
    inFlight = { frame, retransmitsSpent: 0 };
    wire.send(getHostId(), frame);
    armTimer(config.ackTimeoutMs);
  }

  /**
   * Declares the wire dead for this controller's intent stream: the in-flight frame AND everything
   * queued behind it drop together, each with its own terminal `room:intent-undeliverable` (in `cSeq`
   * order). A LATER `send()` starts a fresh cycle — exhaustion is a verdict on the wire now, not a
   * permanent latch.
   *
   * @example
   * ```ts
   * giveUp(); // budget exhausted — surface the dead wire to the app
   * ```
   */
  function giveUp(): void {
    const dead = inFlight ? [inFlight.frame, ...queue] : [...queue];
    inFlight = null;
    queue.length = 0;
    clearTimer();
    for (const frame of dead) {
      emitUndeliverable({ name: frame.name, cSeq: frame.cSeq });
    }
  }

  /**
   * The armed retransmit timeout: re-sends the SAME in-flight frame (same `cSeq` — the host's §4.3
   * de-dup makes the duplicate safe, and its receipt-ack releases the window even for a duplicate) with
   * a doubled next wait, or gives up once the bounded budget is spent.
   *
   * @example
   * ```ts
   * timer = setTimeout(handleAckTimeout, delayMs);
   * ```
   */
  function handleAckTimeout(): void {
    timer = null;

    // Defensive: a receipt that raced the timeout already released the window.
    if (!inFlight) {
      return;
    }

    // Budget spent — the wire is dead for this stream.
    if (inFlight.retransmitsSpent >= config.maxRetransmits) {
      giveUp();
      return;
    }

    // Re-send the SAME frame to the re-resolved host id; double the next wait.
    inFlight.retransmitsSpent += 1;
    wire.send(getHostId(), inFlight.frame);
    armTimer(config.ackTimeoutMs * RETRANSMIT_BACKOFF_FACTOR ** inFlight.retransmitsSpent);
  }

  /* eslint-disable jsdoc/require-jsdoc -- thin object-literal IntentDelivery implementations; each method's contract is documented on the IntentDelivery type in types.ts */
  return {
    send(frame) {
      // Window busy: queue behind the in-flight frame (cSeq order). Past the cap the OLDEST queued
      // intent is dropped with its own terminal event — bounded memory, honest loss.
      if (inFlight) {
        if (queue.length >= config.bufferCap) {
          const dropped = queue.shift();
          if (dropped) {
            emitUndeliverable({ name: dropped.name, cSeq: dropped.cSeq });
          }
        }
        queue.push(frame);
        return;
      }
      transmit(frame);
    },

    onAck(cSeq) {
      // Only the in-flight frame's receipt releases the window; stale/duplicate receipts are no-ops.
      if (!inFlight || inFlight.frame.cSeq !== cSeq) {
        return;
      }
      inFlight = null;
      clearTimer();
      const next = queue.shift();
      if (next) {
        transmit(next);
      }
    },

    retire() {
      const pending = inFlight ? [inFlight.frame, ...queue] : [...queue];
      inFlight = null;
      queue.length = 0;
      clearTimer();
      return pending;
    },

    stop() {
      inFlight = null;
      queue.length = 0;
      clearTimer();
    }
  };
  /* eslint-enable jsdoc/require-jsdoc */
}
