/**
 * Integration tests for the intent plugin via `createApp` + the `inMemory` signaling adapter (D13).
 *
 * Composes a minimal stage + 2 controllers (`transport` + `session` + `intent` only — facades not
 * required for the engine test) over `inMemory` (no real `RTCPeerConnection`) and drives by direct
 * `app.intent.*()` calls. All tests live inside the plugin directory, never in root `tests/`.
 *
 * @file
 * @see ../../index
 */
import { createApp } from "@moku-labs/web";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Frame } from "../../../../contracts";
import { sessionPlugin } from "../../../session";
import { transportPlugin } from "../../../transport";
import { inMemory } from "../../../transport/adapters/in-memory";
import { createIntentApi } from "../../api";
import { DEFAULT_INTENT_CONFIG } from "../../config";
import { intentPlugin } from "../../index";
import { attachIntentReceive } from "../../receive";
import { createIntentState } from "../../state";
import type { IntentSchema } from "../../types";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const moveSchema: IntentSchema = {
  fields: {
    dx: { type: "number", min: -1, max: 1 },
    dy: { type: "number", min: -1, max: 1 }
  },
  additionalFields: false
};

/** A no-op unsubscribe returned by stub `Wire.on` implementations that don't need capture. */
function noopUnsub(): void {
  /* intentional no-op */
}

/** Builds a minimal intent-capable app on the given in-memory bus. */
function makeIntentApp(bus: ReturnType<typeof inMemory>) {
  return createApp({
    plugins: [transportPlugin, sessionPlugin, intentPlugin],
    pluginConfigs: {
      site: { name: "room-test", url: "https://room.test" },
      transport: { signaling: bus },
      session: { generateQr: false, reconnectTimeoutMs: 10_000 }
    }
  });
}

/**
 * Builds a capturing host wire stub. The `on` method stores the last handler so tests can deliver
 * synthetic frames. Returns the wire plus a `deliver` helper.
 */
function makeCapturingWire() {
  let capturedHandler: ((peerId: string, frame: Frame) => void) | null = null;
  const wire = {
    send: vi.fn(),
    broadcast: vi.fn(),
    on(handler: (peerId: string, frame: Frame) => void) {
      capturedHandler = handler;
      return () => {
        capturedHandler = null;
      };
    }
  };
  return {
    wire,
    deliver(peerId: string, frame: Frame) {
      capturedHandler?.(peerId, frame);
    }
  };
}

/** Builds a send-only stub wire (no capture needed — controller side during buffering tests). */
function makeSendWire() {
  return { send: vi.fn(), broadcast: vi.fn(), on: () => noopUnsub };
}

// ---------------------------------------------------------------------------
// End-to-end over inMemory
// ---------------------------------------------------------------------------

describe("intent — end-to-end over inMemory", () => {
  let bus: ReturnType<typeof inMemory>;
  let hostApp: ReturnType<typeof makeIntentApp>;
  let ctrlApp: ReturnType<typeof makeIntentApp>;

  beforeEach(async () => {
    bus = inMemory();
    hostApp = makeIntentApp(bus);
    ctrlApp = makeIntentApp(bus);
    await hostApp.start();
    await ctrlApp.start();

    // Host creates the room; controller joins
    const { code } = hostApp.session.createRoom();
    await ctrlApp.session.joinRoom(code);
  });

  afterEach(async () => {
    await hostApp.stop();
    await ctrlApp.stop();
  });

  it("controller intent('move', …) → host onIntent fires with validated payload + correct peerId/cSeq", async () => {
    const received: Array<{ payload: unknown; peerId: string; cSeq: number }> = [];

    // Host registers and listens
    hostApp.intent.register("move", moveSchema);
    hostApp.intent.onIntent("move", (payload, meta) => {
      received.push({ payload, peerId: meta.peerId, cSeq: meta.cSeq });
    });

    // Controller sends
    ctrlApp.intent.intent("move", { dx: 0.5, dy: -0.3 });

    // Allow inMemory microtasks to deliver the frame
    await vi.waitFor(() => expect(received).toHaveLength(1));

    expect(received[0]?.payload).toEqual({ dx: 0.5, dy: -0.3 });
    expect(received[0]?.cSeq).toBe(0);
    // peerId must be the controller's stable id
    const ctrlSelfId = ctrlApp.session.self().selfId;
    expect(received[0]?.peerId).toBe(ctrlSelfId);
  });

  it("preserves ordering across a burst of intents", async () => {
    const seqs: number[] = [];

    hostApp.intent.register("move", moveSchema);
    hostApp.intent.onIntent("move", (_p, meta) => {
      seqs.push(meta.cSeq);
    });

    // Send a burst of 5 intents
    for (let i = 0; i < 5; i++) {
      ctrlApp.intent.intent("move", { dx: i * 0.1, dy: 0 });
    }

    await vi.waitFor(() => expect(seqs).toHaveLength(5));

    // Must arrive in cSeq order 0–4
    expect(seqs).toEqual([0, 1, 2, 3, 4]);
  });
});

// ---------------------------------------------------------------------------
// Idempotent reconcile (D4) — uses direct unit layer (pure intent logic, no full app needed)
// ---------------------------------------------------------------------------

describe("intent — idempotent reconcile (D4)", () => {
  it("setBuffering(true), fire N intents, drainBuffer(), replay into host receive path twice — each cSeq applies once", () => {
    const { wire: hostWire, deliver } = makeCapturingWire();
    const hostState = createIntentState();
    const ctrlState = createIntentState();
    const ctrlWire = makeSendWire();

    const handlerCalls: number[] = [];
    hostState.registry.set("move", {
      schema: moveSchema,
      handler: (_payload, meta) => {
        handlerCalls.push(meta.cSeq);
      }
    });
    attachIntentReceive(hostState, hostWire);

    const ctrlApi = createIntentApi(ctrlState, DEFAULT_INTENT_CONFIG, ctrlWire, () => "host-id");

    // Controller enters buffering mode
    ctrlApi.setBuffering(true);

    // Fire N=3 intents (buffered, not sent)
    ctrlApi.intent("move", { dx: 0.1, dy: 0 });
    ctrlApi.intent("move", { dx: 0.2, dy: 0 });
    ctrlApi.intent("move", { dx: 0.3, dy: 0 });

    expect(ctrlApi.bufferedCount()).toBe(3);

    // Drain the buffer (simulating sessionPlugin recovery)
    const buffered = ctrlApi.drainBuffer();
    expect(buffered).toHaveLength(3);
    expect(ctrlApi.bufferedCount()).toBe(0);

    // Replay the drained buffer into the host receive path TWICE
    for (const entry of buffered) {
      deliver("ctrl-1", entry.intent);
    }
    for (const entry of buffered) {
      deliver("ctrl-1", entry.intent);
    }

    // Handler must have run exactly N=3 times, NOT 2N=6
    expect(handlerCalls).toHaveLength(3);
    expect(handlerCalls).toEqual([0, 1, 2]);
  });

  it("each cSeq applies exactly once (lastApplied de-dups the replay); handler runs N times, not 2N", () => {
    const { wire: hostWire, deliver } = makeCapturingWire();
    const hostState = createIntentState();
    const ctrlState = createIntentState();
    const ctrlWire = makeSendWire();

    let callCount = 0;
    hostState.registry.set("fire", {
      schema: { fields: {}, additionalFields: true },
      handler: () => {
        callCount++;
      }
    });
    attachIntentReceive(hostState, hostWire);

    const ctrlApi = createIntentApi(ctrlState, DEFAULT_INTENT_CONFIG, ctrlWire, () => "host-id");
    ctrlApi.setBuffering(true);

    const N = 5;
    for (let i = 0; i < N; i++) {
      ctrlApi.intent("fire", {});
    }

    const buffered = ctrlApi.drainBuffer();

    // Replay twice
    for (const entry of buffered) {
      deliver("ctrl-1", entry.intent);
    }
    for (const entry of buffered) {
      deliver("ctrl-1", entry.intent);
    }

    expect(callCount).toBe(N); // NOT 2*N
  });
});

// ---------------------------------------------------------------------------
// Cap/age loss
// ---------------------------------------------------------------------------

describe("intent — cap/age loss", () => {
  it("overflowing bufferCap FIFO-drops the oldest buffered intents", () => {
    const state = createIntentState();
    const wire = makeSendWire();
    const api = createIntentApi(
      state,
      { bufferCap: 3, bufferMaxAgeMs: 10_000 },
      wire,
      () => "host"
    );

    api.setBuffering(true);
    for (let i = 0; i < 5; i++) {
      api.intent("move", { seq: i });
    }

    expect(api.bufferedCount()).toBe(3);
    const drained = api.drainBuffer();
    const seqs = drained.map(e => (e.intent.payload as { seq: number }).seq);
    // Oldest (seq 0, 1) dropped; newest (2, 3, 4) kept
    expect(seqs).toEqual([2, 3, 4]);
  });

  it("advancing fake time past bufferMaxAgeMs prunes stale entries (vi.useFakeTimers)", () => {
    vi.useFakeTimers();

    const state = createIntentState();
    const wire = makeSendWire();
    const api = createIntentApi(state, { bufferCap: 256, bufferMaxAgeMs: 500 }, wire, () => "host");

    api.setBuffering(true);
    api.intent("move", { seq: 0 });
    api.intent("move", { seq: 1 });

    // Advance past max age
    vi.advanceTimersByTime(600);

    // A new enqueue triggers pruning of the stale ones
    api.intent("move", { seq: 2 });

    const drained = api.drainBuffer();
    expect(drained).toHaveLength(1);
    expect((drained[0]?.intent.payload as { seq: number }).seq).toBe(2);

    vi.useRealTimers();
  });
});
