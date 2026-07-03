/**
 * Unit tests for `createIntentApi` against a mock context.
 *
 * A `{ config, state, require, emit }` stub where `require(transportPlugin)` returns a fake `Wire`
 * (a `vi.fn()` `send` + a captured `on` handler) and `require(sessionPlugin)` returns a stub host-id
 * resolver. The SAME mock `ctx.state` is shared by the API and by `attachIntentReceive` in the
 * host-receive cases — proving the per-app `ctx`/`ctx.state` seam (D14) without any module-level instance.
 *
 * @file
 * @see ../../api
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Frame, PeerId, Wire } from "../../../transport/protocol";
import { createIntentApi } from "../../api";
import { attachIntentReceive } from "../../receive";
import { createIntentState } from "../../state";
import type { IntentConfig, IntentSchema, IntentState } from "../../types";

// ---------------------------------------------------------------------------
// Test helpers — fake Wire + mock context pieces
// ---------------------------------------------------------------------------

/** Creates a fake `Wire` that captures the `on` handler and records `send` calls. */
function makeFakeWire() {
  let capturedHandler: ((peerId: PeerId, frame: Frame) => void) | null = null;
  const send = vi.fn<(peerId: PeerId, frame: Frame) => void>();
  const broadcast = vi.fn<(frame: Frame) => void>();

  const wire: Wire = {
    send,
    broadcast,
    on(handler) {
      capturedHandler = handler;
      return () => {
        capturedHandler = null;
      };
    }
  };

  return {
    wire,
    send,
    broadcast,
    /** Fire the captured handler with a synthetic frame (simulates inbound frame from transport). */
    deliver(peerId: PeerId, frame: Frame) {
      capturedHandler?.(peerId, frame);
    }
  };
}

const defaultConfig: IntentConfig = {
  bufferCap: 256,
  bufferMaxAgeMs: 10_000,
  ackTimeoutMs: 1000,
  maxRetransmits: 3
};

/**
 * Delivers the host's wire-level receipt for `cSeq` back into the controller's receive path,
 * releasing the delivery tracker's stop-and-wait window for the next queued intent.
 */
function ackBack(fakeWire: ReturnType<typeof makeFakeWire>, hostId: PeerId, cSeq: number): void {
  fakeWire.deliver(hostId, { t: "intent-ack", cSeq });
}

const moveSchema: IntentSchema = {
  fields: {
    dx: { type: "number", min: -1, max: 1 },
    dy: { type: "number", min: -1, max: 1 }
  },
  additionalFields: false
};

// ---------------------------------------------------------------------------
// Controller intent() tests
// ---------------------------------------------------------------------------

describe("createIntentApi — controller intent()", () => {
  let state: IntentState;
  let fakeWire: ReturnType<typeof makeFakeWire>;
  const hostId = "host-peer-1";

  beforeEach(() => {
    state = createIntentState();
    fakeWire = makeFakeWire();
  });

  it("stamps a monotonic cSeq starting at 0 and increments across calls (ack releases each next send)", () => {
    // The receive path routes the host's intent-ack receipts to the delivery tracker (same state).
    attachIntentReceive(state, fakeWire.wire);
    const api = createIntentApi(state, defaultConfig, fakeWire.wire, () => hostId, vi.fn());

    // Stop-and-wait: only the first frame transmits; the rest queue behind it in cSeq order.
    api.intent("move", { dx: 0.1, dy: 0.2 });
    api.intent("move", { dx: 0.2, dy: 0.3 });
    api.intent("move", { dx: 0.3, dy: 0.4 });
    expect(fakeWire.send).toHaveBeenCalledTimes(1);

    // Each wire-level receipt releases the window and transmits the next queued frame.
    ackBack(fakeWire, hostId, 0);
    ackBack(fakeWire, hostId, 1);
    ackBack(fakeWire, hostId, 2);

    expect(fakeWire.send).toHaveBeenCalledTimes(3);
    const calls = fakeWire.send.mock.calls;
    // cSeq must be 0, 1, 2 in order
    const cSeqs = calls.map(([, frame]) => (frame as { cSeq: number }).cSeq);
    expect(cSeqs).toEqual([0, 1, 2]);
  });

  it("builds the correct IntentFrame and calls wire.send(hostId, frame)", () => {
    const api = createIntentApi(state, defaultConfig, fakeWire.wire, () => hostId, vi.fn());
    api.intent("jump", { height: 1 });

    expect(fakeWire.send).toHaveBeenCalledTimes(1);
    expect(fakeWire.send).toHaveBeenCalledWith(hostId, {
      t: "intent",
      name: "jump",
      payload: { height: 1 },
      cSeq: 0
    });
  });

  it("never routes gameplay through emit (the injected emit fires ONLY for intent-undeliverable)", () => {
    const emitUndeliverable = vi.fn();
    // The API's only emit channel is the terminal room:intent-undeliverable — a live send that is
    // acked (or still in flight) must ride the wire exclusively.
    const api = createIntentApi(
      state,
      defaultConfig,
      fakeWire.wire,
      () => hostId,
      emitUndeliverable
    );
    api.intent("fire", { power: 0.5 });

    // wire.send was called (live send path)
    expect(fakeWire.send).toHaveBeenCalledTimes(1);
    // the narrowed emit never fires for a healthy send
    expect(emitUndeliverable).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Host register() + onIntent() tests (+ attachIntentReceive for delivery)
// ---------------------------------------------------------------------------

describe("createIntentApi — host register() + onIntent()", () => {
  let state: IntentState;
  let fakeWire: ReturnType<typeof makeFakeWire>;
  const hostId = "host-id";

  beforeEach(() => {
    state = createIntentState();
    fakeWire = makeFakeWire();
    // Wire the receive path against the same state
    attachIntentReceive(state, fakeWire.wire);
  });

  it("a valid IntentFrame invokes the handler with (payload, { peerId, cSeq })", () => {
    const api = createIntentApi(state, defaultConfig, fakeWire.wire, () => hostId, vi.fn());
    const handler = vi.fn();
    api.register("move", moveSchema);
    api.onIntent("move", handler);

    fakeWire.deliver("ctrl-1", {
      t: "intent",
      name: "move",
      payload: { dx: 0.5, dy: -0.3 },
      cSeq: 0
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ dx: 0.5, dy: -0.3 }, { peerId: "ctrl-1", cSeq: 0 });
  });

  it("an unregistered name drops silently (handler not called)", () => {
    const api = createIntentApi(state, defaultConfig, fakeWire.wire, () => hostId, vi.fn());
    const handler = vi.fn();
    api.register("move", moveSchema);
    api.onIntent("move", handler);

    // Send a frame with an unregistered name
    fakeWire.deliver("ctrl-1", {
      t: "intent",
      name: "unknown-action",
      payload: { dx: 0 },
      cSeq: 0
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it("a schema-failing payload drops silently (handler not called)", () => {
    const api = createIntentApi(state, defaultConfig, fakeWire.wire, () => hostId, vi.fn());
    const handler = vi.fn();
    api.register("move", moveSchema);
    api.onIntent("move", handler);

    // dx out of bounds
    fakeWire.deliver("ctrl-1", { t: "intent", name: "move", payload: { dx: 5, dy: 0 }, cSeq: 0 });
    // Missing required field
    fakeWire.deliver("ctrl-1", { t: "intent", name: "move", payload: { dx: 0 }, cSeq: 1 });

    expect(handler).not.toHaveBeenCalled();
  });

  it("a duplicate (cSeq <= lastApplied[peerId]) drops silently", () => {
    const api = createIntentApi(state, defaultConfig, fakeWire.wire, () => hostId, vi.fn());
    const handler = vi.fn();
    api.register("move", moveSchema);
    api.onIntent("move", handler);

    // Apply cSeq 5
    fakeWire.deliver("ctrl-1", { t: "intent", name: "move", payload: { dx: 0, dy: 0 }, cSeq: 5 });
    expect(handler).toHaveBeenCalledTimes(1);

    // Re-deliver cSeq 5 (duplicate — must drop)
    fakeWire.deliver("ctrl-1", { t: "intent", name: "move", payload: { dx: 0, dy: 0 }, cSeq: 5 });
    // Earlier cSeq (must drop)
    fakeWire.deliver("ctrl-1", { t: "intent", name: "move", payload: { dx: 0, dy: 0 }, cSeq: 3 });
    expect(handler).toHaveBeenCalledTimes(1); // still only once
  });

  it("lastApplied[peerId] advances only on applied frames; two peers stay independent", () => {
    const api = createIntentApi(state, defaultConfig, fakeWire.wire, () => hostId, vi.fn());
    const handler = vi.fn();
    api.register("move", moveSchema);
    api.onIntent("move", handler);

    // ctrl-a gets cSeq 10
    fakeWire.deliver("ctrl-a", { t: "intent", name: "move", payload: { dx: 0, dy: 0 }, cSeq: 10 });
    // ctrl-b starts at cSeq 0 — independent high-water mark
    fakeWire.deliver("ctrl-b", { t: "intent", name: "move", payload: { dx: 0, dy: 0 }, cSeq: 0 });
    fakeWire.deliver("ctrl-b", { t: "intent", name: "move", payload: { dx: 0, dy: 0 }, cSeq: 1 });

    expect(handler).toHaveBeenCalledTimes(3);
    expect(state.lastApplied.get("ctrl-a")).toBe(10);
    expect(state.lastApplied.get("ctrl-b")).toBe(1);

    // ctrl-a cSeq 9 is below its high-water mark — must drop
    fakeWire.deliver("ctrl-a", { t: "intent", name: "move", payload: { dx: 0, dy: 0 }, cSeq: 9 });
    expect(handler).toHaveBeenCalledTimes(3); // no new call
  });

  it("onIntent returns an unsubscribe that detaches the handler", () => {
    const api = createIntentApi(state, defaultConfig, fakeWire.wire, () => hostId, vi.fn());
    const handler = vi.fn();
    api.register("move", moveSchema);
    const off = api.onIntent("move", handler);

    // First delivery — handler fires
    fakeWire.deliver("ctrl-1", { t: "intent", name: "move", payload: { dx: 0, dy: 0 }, cSeq: 0 });
    expect(handler).toHaveBeenCalledTimes(1);

    // Unsubscribe
    off();

    // Subsequent delivery — handler must NOT fire (registration remains, but handler detached)
    fakeWire.deliver("ctrl-1", { t: "intent", name: "move", payload: { dx: 0, dy: 0 }, cSeq: 1 });
    expect(handler).toHaveBeenCalledTimes(1); // still only once
  });
});

// ---------------------------------------------------------------------------
// Buffer seam tests
// ---------------------------------------------------------------------------

describe("createIntentApi — buffer seam", () => {
  let state: IntentState;
  let fakeWire: ReturnType<typeof makeFakeWire>;
  const hostId = "host-id";

  beforeEach(() => {
    state = createIntentState();
    fakeWire = makeFakeWire();
  });

  it("setBuffering(true) makes intent() enqueue instead of send", () => {
    const api = createIntentApi(state, defaultConfig, fakeWire.wire, () => hostId, vi.fn());
    api.setBuffering(true);
    api.intent("move", { dx: 0.1, dy: 0.2 });
    api.intent("move", { dx: 0.3, dy: 0.4 });

    expect(fakeWire.send).not.toHaveBeenCalled();
    expect(state.buffer).toHaveLength(2);
  });

  it("setBuffering(true) retires the live delivery window into the reconnect buffer (cSeq order, silent)", () => {
    vi.useFakeTimers();
    const emitUndeliverable = vi.fn();
    const api = createIntentApi(
      state,
      defaultConfig,
      fakeWire.wire,
      () => hostId,
      emitUndeliverable
    );

    // Live sends: one in flight (unacked), two queued behind it in the stop-and-wait window.
    api.intent("move", { dx: 0.1, dy: 0 });
    api.intent("move", { dx: 0.2, dy: 0 });
    api.intent("move", { dx: 0.3, dy: 0 });
    expect(fakeWire.send).toHaveBeenCalledTimes(1);

    // Known host absence: the §5 recovery contract subsumes the live window.
    api.setBuffering(true);

    expect(api.bufferedCount()).toBe(3);
    const drained = api.drainBuffer();
    expect(drained.map(entry => entry.intent.cSeq)).toEqual([0, 1, 2]);

    // Retirement disarmed the retransmit loop: no re-sends into the dead wire, no terminal events.
    vi.advanceTimersByTime(60_000);
    expect(fakeWire.send).toHaveBeenCalledTimes(1);
    expect(emitUndeliverable).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("bufferedCount() reflects the queue size", () => {
    const api = createIntentApi(state, defaultConfig, fakeWire.wire, () => hostId, vi.fn());
    api.setBuffering(true);
    expect(api.bufferedCount()).toBe(0);

    api.intent("a", { x: 1 });
    expect(api.bufferedCount()).toBe(1);

    api.intent("b", { x: 2 });
    expect(api.bufferedCount()).toBe(2);
  });

  it("drainBuffer() returns ts-ordered entries and empties the buffer", () => {
    const api = createIntentApi(state, defaultConfig, fakeWire.wire, () => hostId, vi.fn());
    api.setBuffering(true);

    api.intent("move", { dx: 0.1 });
    api.intent("move", { dx: 0.2 });
    api.intent("move", { dx: 0.3 });

    const drained = api.drainBuffer();
    expect(drained).toHaveLength(3);
    // Must be ts-ordered (enqueue order = time order in single-threaded JS)
    for (let i = 1; i < drained.length; i++) {
      expect((drained[i] as { ts: number }).ts).toBeGreaterThanOrEqual(
        (drained[i - 1] as { ts: number }).ts
      );
    }
    // Buffer must be empty after drain
    expect(api.bufferedCount()).toBe(0);
    // Second drain returns empty
    expect(api.drainBuffer()).toHaveLength(0);
  });

  it("bufferCap FIFO-drops the oldest entries past the cap", () => {
    const smallCap = 3;
    const cfg: IntentConfig = { ...defaultConfig, bufferCap: smallCap };
    const api = createIntentApi(state, cfg, fakeWire.wire, () => hostId, vi.fn());
    api.setBuffering(true);

    // Push 5 intents — first 2 should be FIFO-dropped
    for (let i = 0; i < 5; i++) {
      api.intent("move", { seq: i });
    }

    expect(api.bufferedCount()).toBe(smallCap);
    const drained = api.drainBuffer();
    // The 3 newest intents should be present (seq 2, 3, 4)
    const seqs = drained.map(entry => (entry.intent.payload as { seq: number }).seq);
    expect(seqs).toEqual([2, 3, 4]);
  });

  it("bufferMaxAgeMs prunes stale entries on enqueue/drain", () => {
    vi.useFakeTimers();

    const cfg: IntentConfig = { ...defaultConfig, bufferMaxAgeMs: 1000 };
    const api = createIntentApi(state, cfg, fakeWire.wire, () => hostId, vi.fn());
    api.setBuffering(true);

    // Add two intents at t=0
    api.intent("move", { dx: 0.1 });
    api.intent("move", { dx: 0.2 });

    // Advance time past max age
    vi.advanceTimersByTime(1100);

    // Add a third intent at t=1100 — enqueue triggers pruning of the first two
    api.intent("move", { dx: 0.3 });

    expect(api.bufferedCount()).toBe(1); // only the fresh one remains

    const drained = api.drainBuffer();
    expect(drained).toHaveLength(1);
    expect((drained[0]?.intent.payload as { dx: number }).dx).toBe(0.3);

    vi.useRealTimers();
  });
});
