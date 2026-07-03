/**
 * Unit tests for `attachIntentReceive` against a mock context.
 *
 * Fake `Wire` that captures the `on` handler; driven directly with the per-app `state` — no API instance
 * and no module-level singleton (D14): a second app's `state` yields an independent registration over its
 * own state. Covers both halves of the §4.3 at-least-once loop: the host half's wire-level `intent-ack`
 * receipt (sent for EVERY inbound intent — fresh, duplicate, unregistered, shape-failing) and the
 * controller half's routing of inbound receipts to `state.delivery`.
 *
 * @file
 * @see ../../receive
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Frame, PeerId, Wire } from "../../../transport/protocol";
import { attachIntentReceive } from "../../receive";
import { createIntentState } from "../../state";
import type { IntentDelivery, IntentSchema, IntentState } from "../../types";

/** Creates a fake `Wire` that captures the last `on` handler. */
function makeFakeWire() {
  let capturedHandler: ((peerId: PeerId, frame: Frame) => void) | null = null;

  const wire: Wire = {
    send: vi.fn(),
    broadcast: vi.fn(),
    on(handler) {
      capturedHandler = handler;
      return () => {
        capturedHandler = null;
      };
    }
  };

  return {
    wire,
    deliver(peerId: PeerId, frame: Frame) {
      capturedHandler?.(peerId, frame);
    },
    hasHandler() {
      return capturedHandler !== null;
    }
  };
}

const moveSchema: IntentSchema = {
  fields: {
    dx: { type: "number", min: -1, max: 1 },
    dy: { type: "number", min: -1, max: 1 }
  },
  additionalFields: false
};

describe("attachIntentReceive", () => {
  let state: IntentState;
  let fakeWire: ReturnType<typeof makeFakeWire>;

  beforeEach(() => {
    state = createIntentState();
    fakeWire = makeFakeWire();
  });

  it("registers exactly one Wire.on handler", () => {
    attachIntentReceive(state, fakeWire.wire);
    expect(fakeWire.hasHandler()).toBe(true);
  });

  it("filters to frame.t === 'intent' and ignores other frame tags", () => {
    const handler = vi.fn();
    state.registry.set("move", { schema: moveSchema, handler });
    attachIntentReceive(state, fakeWire.wire);

    // Non-intent frames must be ignored
    fakeWire.deliver("ctrl-1", { t: "ping", ts: Date.now() });
    fakeWire.deliver("ctrl-1", { t: "sync-snap", snapshot: {}, sSeq: 0 });
    expect(handler).not.toHaveBeenCalled();

    // Intent frame must dispatch
    fakeWire.deliver("ctrl-1", { t: "intent", name: "move", payload: { dx: 0, dy: 0 }, cSeq: 0 });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("routes into ctx.state: validate → de-dup vs lastApplied → dispatch to registry handler", () => {
    const handler = vi.fn();
    state.registry.set("move", { schema: moveSchema, handler });
    attachIntentReceive(state, fakeWire.wire);

    // Valid frame → handler fires, lastApplied updated
    fakeWire.deliver("ctrl-1", {
      t: "intent",
      name: "move",
      payload: { dx: 0.5, dy: 0.5 },
      cSeq: 3
    });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ dx: 0.5, dy: 0.5 }, { peerId: "ctrl-1", cSeq: 3 });
    expect(state.lastApplied.get("ctrl-1")).toBe(3);

    // Duplicate cSeq → drop
    fakeWire.deliver("ctrl-1", {
      t: "intent",
      name: "move",
      payload: { dx: 0.5, dy: 0.5 },
      cSeq: 3
    });
    expect(handler).toHaveBeenCalledTimes(1);

    // Invalid payload → drop, lastApplied NOT advanced beyond 3
    fakeWire.deliver("ctrl-1", { t: "intent", name: "move", payload: { dx: 99, dy: 0 }, cSeq: 4 });
    expect(handler).toHaveBeenCalledTimes(1);
    // lastApplied stays at 3 (frame was dropped before advancing)
    expect(state.lastApplied.get("ctrl-1")).toBe(3);
  });

  it("a second app's ctx yields an independent registration over its own ctx.state", () => {
    const handler1 = vi.fn();
    const handler2 = vi.fn();

    // App 1
    const state1 = createIntentState();
    state1.registry.set("move", { schema: moveSchema, handler: handler1 });
    const wire1 = makeFakeWire();
    attachIntentReceive(state1, wire1.wire);

    // App 2 — completely separate state + wire
    const state2 = createIntentState();
    state2.registry.set("move", { schema: moveSchema, handler: handler2 });
    const wire2 = makeFakeWire();
    attachIntentReceive(state2, wire2.wire);

    // Deliver to app1's wire
    wire1.deliver("ctrl-1", { t: "intent", name: "move", payload: { dx: 0, dy: 0 }, cSeq: 0 });
    expect(handler1).toHaveBeenCalledTimes(1);
    expect(handler2).not.toHaveBeenCalled();

    // Deliver to app2's wire
    wire2.deliver("ctrl-2", { t: "intent", name: "move", payload: { dx: 0, dy: 0 }, cSeq: 0 });
    expect(handler1).toHaveBeenCalledTimes(1); // unchanged
    expect(handler2).toHaveBeenCalledTimes(1);

    // State is independent
    expect(state1.lastApplied.get("ctrl-1")).toBe(0);
    expect(state2.lastApplied.get("ctrl-2")).toBe(0);
    expect(state1.lastApplied.has("ctrl-2")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Wire-level intent-ack receipt (§4.3 at-least-once — host half)
// ---------------------------------------------------------------------------

describe("attachIntentReceive — intent-ack receipt", () => {
  let state: IntentState;
  let fakeWire: ReturnType<typeof makeFakeWire>;

  beforeEach(() => {
    state = createIntentState();
    fakeWire = makeFakeWire();
    attachIntentReceive(state, fakeWire.wire);
  });

  it("acks a fresh applied intent back to its sender", () => {
    const handler = vi.fn();
    state.registry.set("move", { schema: moveSchema, handler });

    fakeWire.deliver("ctrl-1", { t: "intent", name: "move", payload: { dx: 0, dy: 0 }, cSeq: 7 });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(fakeWire.wire.send).toHaveBeenCalledTimes(1);
    expect(fakeWire.wire.send).toHaveBeenCalledWith("ctrl-1", { t: "intent-ack", cSeq: 7 });
  });

  it("re-acks a de-dup-dropped duplicate (a lost ack must not retransmit to exhaustion)", () => {
    const handler = vi.fn();
    state.registry.set("move", { schema: moveSchema, handler });

    fakeWire.deliver("ctrl-1", { t: "intent", name: "move", payload: { dx: 0, dy: 0 }, cSeq: 3 });
    fakeWire.deliver("ctrl-1", { t: "intent", name: "move", payload: { dx: 0, dy: 0 }, cSeq: 3 });

    // Applied once, acked TWICE — receipt is per received frame, not per application.
    expect(handler).toHaveBeenCalledTimes(1);
    expect(fakeWire.wire.send).toHaveBeenCalledTimes(2);
    expect(fakeWire.wire.send).toHaveBeenNthCalledWith(2, "ctrl-1", { t: "intent-ack", cSeq: 3 });
  });

  it("acks receipt even for an unregistered name and a shape-failing payload (D6 drops are not wire failures)", () => {
    state.registry.set("move", { schema: moveSchema, handler: vi.fn() });

    // Unregistered name — silently dropped by the pipeline, still receipt-acked.
    fakeWire.deliver("ctrl-1", { t: "intent", name: "unknown", payload: {}, cSeq: 0 });
    // Shape-failing payload — silently dropped by the pipeline, still receipt-acked.
    fakeWire.deliver("ctrl-1", { t: "intent", name: "move", payload: { dx: 99, dy: 0 }, cSeq: 1 });

    expect(fakeWire.wire.send).toHaveBeenCalledTimes(2);
    expect(fakeWire.wire.send).toHaveBeenNthCalledWith(1, "ctrl-1", { t: "intent-ack", cSeq: 0 });
    expect(fakeWire.wire.send).toHaveBeenNthCalledWith(2, "ctrl-1", { t: "intent-ack", cSeq: 1 });
  });

  it("routes an inbound intent-ack to state.delivery.onAck (controller half) and never acks an ack", () => {
    const onAck = vi.fn();
    const delivery: IntentDelivery = {
      send: vi.fn(),
      onAck,
      retire: vi.fn(() => []),
      stop: vi.fn()
    };
    state.delivery = delivery;

    fakeWire.deliver("host-id", { t: "intent-ack", cSeq: 5 });

    expect(onAck).toHaveBeenCalledTimes(1);
    expect(onAck).toHaveBeenCalledWith(5);
    // An inbound receipt is terminal: no echo, no ack-of-ack.
    expect(fakeWire.wire.send).not.toHaveBeenCalled();
  });

  it("an inbound intent-ack with no delivery tracker attached is a safe no-op", () => {
    expect(state.delivery).toBeNull();
    expect(() => fakeWire.deliver("host-id", { t: "intent-ack", cSeq: 5 })).not.toThrow();
    expect(fakeWire.wire.send).not.toHaveBeenCalled();
  });
});
