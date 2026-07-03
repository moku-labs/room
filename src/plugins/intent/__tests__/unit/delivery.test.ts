/**
 * Unit tests for `createIntentDelivery` — the controller-side at-least-once delivery tracker (§4.3).
 *
 * A fake `Wire` (vi.fn `send`) + fake timers drive the stop-and-wait window deterministically: one
 * unacked frame in flight, FIFO queue behind it, SAME-frame retransmits on a doubling backoff, terminal
 * `room:intent-undeliverable` on budget exhaustion, and the recovery/teardown seams (`retire`/`stop`).
 *
 * @file
 * @see ../../delivery
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Frame, IntentFrame, PeerId } from "../../../transport/protocol";
import { createIntentDelivery } from "../../delivery";
import type { IntentConfig } from "../../types";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** A no-op unsubscribe returned by the stub `Wire.on` (the tracker never registers a handler). */
const noopUnsubscribe = () => {};

/** Creates a send-recording fake `Wire` (the tracker only ever calls `send`). */
function makeWire() {
  return {
    send: vi.fn<(peerId: PeerId, frame: Frame) => void>(),
    broadcast: vi.fn<(frame: Frame) => void>(),
    on: () => noopUnsubscribe
  };
}

const baseConfig: IntentConfig = {
  bufferCap: 256,
  bufferMaxAgeMs: 10_000,
  ackTimeoutMs: 100,
  maxRetransmits: 3
};

/** Builds a cSeq-stamped intent frame for the tests. */
function frameOf(cSeq: number, name = "move"): IntentFrame {
  return { t: "intent", name, payload: { cSeq }, cSeq };
}

function makeTracker(configOverrides?: Partial<IntentConfig>, hostId: PeerId = "host-id") {
  const wire = makeWire();
  const emit = vi.fn<(payload: { name: string; cSeq: number }) => void>();
  const getHostId = vi.fn(() => hostId);
  const tracker = createIntentDelivery(
    { ...baseConfig, ...configOverrides },
    wire,
    getHostId,
    emit
  );
  return { tracker, wire, emit, getHostId };
}

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

describe("createIntentDelivery — config validation", () => {
  it("rejects ackTimeoutMs < 1 (and non-finite) with a [room]-formatted error", () => {
    expect(() => makeTracker({ ackTimeoutMs: 0 })).toThrow(/\[room\] intent\.ackTimeoutMs/);
    expect(() => makeTracker({ ackTimeoutMs: Number.NaN })).toThrow(
      /\[room\] intent\.ackTimeoutMs/
    );
  });

  it("rejects a negative or fractional maxRetransmits with a [room]-formatted error", () => {
    expect(() => makeTracker({ maxRetransmits: -1 })).toThrow(/\[room\] intent\.maxRetransmits/);
    expect(() => makeTracker({ maxRetransmits: 1.5 })).toThrow(/\[room\] intent\.maxRetransmits/);
  });
});

// ---------------------------------------------------------------------------
// Stop-and-wait window + ack release
// ---------------------------------------------------------------------------

describe("createIntentDelivery — window + ack", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("transmits the first frame immediately to the resolved host id", () => {
    const { tracker, wire } = makeTracker();

    tracker.send(frameOf(0));

    expect(wire.send).toHaveBeenCalledTimes(1);
    expect(wire.send).toHaveBeenCalledWith("host-id", frameOf(0));
  });

  it("queues later frames behind the unacked in-flight one; each receipt promotes the next in cSeq order", () => {
    const { tracker, wire } = makeTracker();

    tracker.send(frameOf(0));
    tracker.send(frameOf(1));
    tracker.send(frameOf(2));
    expect(wire.send).toHaveBeenCalledTimes(1);

    tracker.onAck(0);
    expect(wire.send).toHaveBeenCalledTimes(2);
    tracker.onAck(1);
    expect(wire.send).toHaveBeenCalledTimes(3);
    tracker.onAck(2);

    const sentSeqs = wire.send.mock.calls.map(([, frame]) => (frame as IntentFrame).cSeq);
    expect(sentSeqs).toEqual([0, 1, 2]);
  });

  it("ignores a receipt that does not match the in-flight frame (stale / duplicate / unknown)", () => {
    const { tracker, wire } = makeTracker();

    tracker.send(frameOf(3));
    tracker.send(frameOf(4));

    tracker.onAck(99); // unknown — window stays busy
    tracker.onAck(4); // queued but NOT in flight — must not release out of order
    expect(wire.send).toHaveBeenCalledTimes(1);

    tracker.onAck(3); // the real receipt releases the window
    expect(wire.send).toHaveBeenCalledTimes(2);
    tracker.onAck(3); // duplicate of an already-released receipt — no-op
    expect(wire.send).toHaveBeenCalledTimes(2);
  });

  it("an acked window with an empty queue accepts the next send immediately", () => {
    const { tracker, wire } = makeTracker();

    tracker.send(frameOf(0));
    tracker.onAck(0);
    tracker.send(frameOf(1));

    expect(wire.send).toHaveBeenCalledTimes(2);
    expect(wire.send).toHaveBeenNthCalledWith(2, "host-id", frameOf(1));
  });
});

// ---------------------------------------------------------------------------
// Bounded retransmit loop (§4.3)
// ---------------------------------------------------------------------------

describe("createIntentDelivery — retransmit loop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("re-sends the SAME frame (same cSeq) after ackTimeoutMs of silence", () => {
    const { tracker, wire } = makeTracker();

    tracker.send(frameOf(0));
    vi.advanceTimersByTime(100);

    expect(wire.send).toHaveBeenCalledTimes(2);
    expect(wire.send).toHaveBeenNthCalledWith(2, "host-id", frameOf(0));
  });

  it("doubles the wait after each retransmit (1×, 2×, 4× the base)", () => {
    const { tracker, wire } = makeTracker();

    tracker.send(frameOf(0));

    vi.advanceTimersByTime(99);
    expect(wire.send).toHaveBeenCalledTimes(1); // base wait not yet elapsed
    vi.advanceTimersByTime(1);
    expect(wire.send).toHaveBeenCalledTimes(2); // retransmit #1 at 1× (100 ms)

    vi.advanceTimersByTime(199);
    expect(wire.send).toHaveBeenCalledTimes(2); // 2× wait not yet elapsed
    vi.advanceTimersByTime(1);
    expect(wire.send).toHaveBeenCalledTimes(3); // retransmit #2 at 2× (200 ms)

    vi.advanceTimersByTime(399);
    expect(wire.send).toHaveBeenCalledTimes(3); // 4× wait not yet elapsed
    vi.advanceTimersByTime(1);
    expect(wire.send).toHaveBeenCalledTimes(4); // retransmit #3 at 4× (400 ms)
  });

  it("a receipt cancels the armed retransmit (no ghost re-send later)", () => {
    const { tracker, wire } = makeTracker();

    tracker.send(frameOf(0));
    tracker.onAck(0);
    vi.advanceTimersByTime(10_000);

    expect(wire.send).toHaveBeenCalledTimes(1);
  });

  it("re-resolves the host id on every attempt (a pre-join send heals once the host is known)", () => {
    let hostId: PeerId = ""; // sessionPlugin.hostId() pre-join
    const wire = makeWire();
    const emit = vi.fn();
    const tracker = createIntentDelivery(baseConfig, wire, () => hostId, emit);

    tracker.send(frameOf(0));
    expect(wire.send).toHaveBeenNthCalledWith(1, "", frameOf(0)); // silent transport no-op

    hostId = "host-late";
    vi.advanceTimersByTime(100);
    expect(wire.send).toHaveBeenNthCalledWith(2, "host-late", frameOf(0));
  });
});

// ---------------------------------------------------------------------------
// Terminal give-up (`room:intent-undeliverable`)
// ---------------------------------------------------------------------------

describe("createIntentDelivery — budget exhaustion", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("drops the in-flight frame AND everything queued behind it, one event each in cSeq order", () => {
    const { tracker, wire, emit } = makeTracker({ maxRetransmits: 2 });

    tracker.send(frameOf(0, "lock"));
    tracker.send(frameOf(1, "emoji"));
    tracker.send(frameOf(2, "emoji"));

    // Silence through the whole budget: base + 2× + 4× (the wait after the final retransmit).
    vi.advanceTimersByTime(100 + 200 + 400);

    // Initial transmit + 2 retransmits of the head — the queued frames were NEVER transmitted.
    expect(wire.send).toHaveBeenCalledTimes(3);
    for (const [, frame] of wire.send.mock.calls) {
      expect((frame as IntentFrame).cSeq).toBe(0);
    }

    expect(emit.mock.calls.map(([payload]) => payload)).toEqual([
      { name: "lock", cSeq: 0 },
      { name: "emoji", cSeq: 1 },
      { name: "emoji", cSeq: 2 }
    ]);
  });

  it("maxRetransmits: 0 never re-sends — one transmit, then the terminal event after one wait", () => {
    const { tracker, wire, emit } = makeTracker({ maxRetransmits: 0 });

    tracker.send(frameOf(0));
    vi.advanceTimersByTime(100);

    expect(wire.send).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({ name: "move", cSeq: 0 });
  });

  it("exhaustion is a verdict, not a latch: a later send starts a fresh tracked cycle", () => {
    const { tracker, wire, emit } = makeTracker({ maxRetransmits: 0 });

    tracker.send(frameOf(0));
    vi.advanceTimersByTime(100); // dead
    expect(emit).toHaveBeenCalledTimes(1);

    tracker.send(frameOf(1));
    expect(wire.send).toHaveBeenNthCalledWith(2, "host-id", frameOf(1));
    tracker.onAck(1); // the wire healed — the new cycle completes normally
    vi.advanceTimersByTime(10_000);
    expect(emit).toHaveBeenCalledTimes(1); // no further terminal events
  });

  it("past bufferCap the OLDEST queued intent drops immediately with its own terminal event", () => {
    const { tracker, wire, emit } = makeTracker({ bufferCap: 2 });

    tracker.send(frameOf(0)); // in flight
    tracker.send(frameOf(1)); // queued
    tracker.send(frameOf(2)); // queued (cap reached)
    tracker.send(frameOf(3)); // overflow → frame 1 drops

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({ name: "move", cSeq: 1 });

    // The survivors still deliver in order: 0 (in flight), then 2, then 3.
    tracker.onAck(0);
    tracker.onAck(2);
    tracker.onAck(3);
    const sentSeqs = wire.send.mock.calls.map(([, frame]) => (frame as IntentFrame).cSeq);
    expect(sentSeqs).toEqual([0, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// Recovery + teardown seams
// ---------------------------------------------------------------------------

describe("createIntentDelivery — retire() and stop()", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retire() returns the in-flight frame plus the queue in cSeq order, silently, and disarms the timer", () => {
    const { tracker, wire, emit } = makeTracker();

    tracker.send(frameOf(0));
    tracker.send(frameOf(1));
    tracker.send(frameOf(2));

    const retired = tracker.retire();

    expect(retired.map(frame => frame.cSeq)).toEqual([0, 1, 2]);
    expect(emit).not.toHaveBeenCalled(); // retirement is the recovery contract, not a wire death
    vi.advanceTimersByTime(10_000);
    expect(wire.send).toHaveBeenCalledTimes(1); // no retransmits after retirement
    expect(emit).not.toHaveBeenCalled();
  });

  it("retire() with nothing tracked returns an empty list", () => {
    const { tracker } = makeTracker();
    expect(tracker.retire()).toEqual([]);
  });

  it("stop() drops everything silently and disarms the timer (idempotent)", () => {
    const { tracker, wire, emit } = makeTracker();

    tracker.send(frameOf(0));
    tracker.send(frameOf(1));

    tracker.stop();
    tracker.stop(); // idempotent

    vi.advanceTimersByTime(10_000);
    expect(wire.send).toHaveBeenCalledTimes(1); // only the original transmit
    expect(emit).not.toHaveBeenCalled(); // teardown is silent — no terminal events at app stop
  });
});
