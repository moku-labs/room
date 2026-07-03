/**
 * Integration tests for the §4.3 at-least-once intent delivery loop via `createApp` + the `inMemory`
 * signaling adapter (D13): a real stage + controller pair over an in-process wire whose loopback
 * channels are wrapped to DROP selected frame tags per role — the same at-most-once loss point a
 * half-open `RTCDataChannel` has. Covers the three wire-failure shapes end-to-end: a dropped intent
 * (retransmit heals it, applied exactly once), a dropped ack (duplicate re-send is de-duped AND
 * re-acked), and a permanently dead wire (terminal `room:intent-undeliverable` for the in-flight
 * intent and everything queued behind it).
 *
 * @file
 * @see ../../delivery
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, createPlugin } from "../../../../index";
import { inMemory } from "../../../transport/adapters/in-memory";
import type { LoopbackSignaling, WireChannel } from "../../../transport/channel";
import type { Signaling, SignalingJoinOpts, SignalingSession } from "../../../transport/protocol";
import { intentPlugin } from "../../index";
import type { IntentSchema } from "../../types";

// ---------------------------------------------------------------------------
// Test helpers — a lossy wrapper over the inMemory loopback channels
// ---------------------------------------------------------------------------

const lockSchema: IntentSchema = {
  fields: { qid: { type: "number" } },
  additionalFields: false
};

/** Reads the frame tag out of a serialized wire message (chunk envelopes have no `t`). */
function frameTag(data: string): string | undefined {
  return (JSON.parse(data) as { t?: string }).t;
}

/** Decides whether one serialized outbound message is dropped, given the sender's join role. */
type DropPredicate = (data: string, opts: SignalingJoinOpts) => boolean;

/** Wraps a loopback endpoint so outbound sends can be dropped — the at-most-once loss point. */
function lossyEndpoint(
  inner: WireChannel,
  opts: SignalingJoinOpts,
  shouldDrop: DropPredicate
): WireChannel {
  return {
    get bufferedAmount() {
      return inner.bufferedAmount;
    },
    get bufferedAmountLowThreshold() {
      return inner.bufferedAmountLowThreshold;
    },
    set bufferedAmountLowThreshold(value: number) {
      inner.bufferedAmountLowThreshold = value;
    },
    get readyState() {
      return inner.readyState;
    },
    get onmessage() {
      return inner.onmessage;
    },
    set onmessage(handler: ((event: { data: string }) => void) | null) {
      // eslint-disable-next-line unicorn/prefer-add-event-listener -- delegating accessor: WireChannel.onmessage is the unified message sink (see channel.ts); the wrapper must forward it to the inner pipe
      inner.onmessage = handler;
    },
    send(data: string) {
      if (shouldDrop(data, opts)) {
        return; // vanished on the half-open channel
      }
      inner.send(data);
    },
    addEventListener(type: string, cb: () => void) {
      inner.addEventListener(type, cb);
    },
    removeEventListener(type: string, cb: () => void) {
      inner.removeEventListener(type, cb);
    },
    close() {
      inner.close();
    }
  };
}

/** Wraps an `inMemory` bus so every session's loopback channels drop per the predicate. */
function lossySignaling(bus: Signaling, shouldDrop: DropPredicate): Signaling {
  return {
    async join(code, opts) {
      const session = await bus.join(code, opts);
      if (!("openWireChannel" in session)) {
        return session;
      }
      const loopback = session as SignalingSession & LoopbackSignaling;
      return {
        ...loopback,
        openWireChannel(peerId: string) {
          const channel = loopback.openWireChannel(peerId);
          return channel ? lossyEndpoint(channel, opts, shouldDrop) : null;
        }
      };
    }
  };
}

/** Builds an intent-capable app over the (possibly lossy) signaling, with a fast retransmit budget. */
function makeApp(
  signaling: Signaling,
  intentConfig: { ackTimeoutMs: number; maxRetransmits: number },
  onUndeliverable?: (payload: { name: string; cSeq: number }) => void
) {
  // Per-test probe plugin: the app-level subscriber for the ONE event intentPlugin owns.
  const probePlugin = createPlugin("probe", {
    depends: [intentPlugin],
    hooks: () => ({
      "room:intent-undeliverable": payload => onUndeliverable?.(payload)
    })
  });
  return createApp({
    plugins: [probePlugin],
    pluginConfigs: {
      transport: { signaling },
      session: { generateQr: false, reconnectTimeoutMs: 10_000 },
      intent: intentConfig
    }
  });
}

// ---------------------------------------------------------------------------
// At-least-once over a lossy wire
// ---------------------------------------------------------------------------

describe("intent delivery — at-least-once over a lossy inMemory wire", () => {
  const flags = { dropCtrlIntents: false, dropHostAcks: false };
  let hostApp: ReturnType<typeof makeApp>;
  let ctrlApp: ReturnType<typeof makeApp>;

  /** Controller→host `intent` frames drop while `dropCtrlIntents`; host→controller `intent-ack` receipts drop while `dropHostAcks`. */
  const shouldDrop: DropPredicate = (data, opts) => {
    const tag = frameTag(data);
    if (opts.passive === true) {
      return flags.dropCtrlIntents && tag === "intent";
    }
    return flags.dropHostAcks && tag === "intent-ack";
  };

  beforeEach(async () => {
    flags.dropCtrlIntents = false;
    flags.dropHostAcks = false;
    const bus = lossySignaling(inMemory(), shouldDrop);
    hostApp = makeApp(bus, { ackTimeoutMs: 40, maxRetransmits: 5 });
    ctrlApp = makeApp(bus, { ackTimeoutMs: 40, maxRetransmits: 5 });
    await hostApp.start();
    await ctrlApp.start();

    const { code } = hostApp.session.createRoom();
    await ctrlApp.session.joinRoom(code);
  });

  afterEach(async () => {
    await hostApp.stop();
    await ctrlApp.stop();
  });

  it("a dropped intent frame self-heals via retransmit and applies exactly once", async () => {
    const received: number[] = [];
    hostApp.intent.register("lock", lockSchema);
    hostApp.intent.onIntent("lock", (_payload, meta) => received.push(meta.cSeq));

    // The wire goes half-open for the controller's outbound: the live send AND the first retransmit
    // (t≈40 ms) both vanish — the exact shape the app-level self-heal watchdogs existed for.
    flags.dropCtrlIntents = true;
    ctrlApp.intent.intent("lock", { qid: 1 });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(received).toHaveLength(0);

    // The channel recovers; the next backoff retransmit (t≈120 ms) delivers the SAME frame.
    flags.dropCtrlIntents = false;
    await vi.waitFor(() => expect(received).toEqual([0]));

    // The receipt released the window: a follow-up intent flows straight through.
    ctrlApp.intent.intent("lock", { qid: 2 });
    await vi.waitFor(() => expect(received).toEqual([0, 1]));
  });

  it("a dropped ack re-acks the duplicate re-send: applied exactly once, window still releases", async () => {
    const received: number[] = [];
    hostApp.intent.register("lock", lockSchema);
    hostApp.intent.onIntent("lock", (_payload, meta) => received.push(meta.cSeq));

    // The intent LANDS but its receipt vanishes: the controller keeps re-sending the same cSeq, the
    // host de-dups every duplicate yet must RE-ACK each one.
    flags.dropHostAcks = true;
    ctrlApp.intent.intent("lock", { qid: 1 });
    await vi.waitFor(() => expect(received).toEqual([0]));
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(received).toEqual([0]); // duplicates de-duped — applied exactly once

    // Acks flow again: the next duplicate's re-ack releases the window for the follow-up intent.
    flags.dropHostAcks = false;
    ctrlApp.intent.intent("lock", { qid: 2 });
    await vi.waitFor(() => expect(received).toEqual([0, 1]));
  });
});

// ---------------------------------------------------------------------------
// Terminal room:intent-undeliverable on a dead wire
// ---------------------------------------------------------------------------

describe("intent delivery — terminal undeliverable on a dead wire", () => {
  it("a permanently dead wire drops the in-flight intent AND the queue, one event each", async () => {
    const undeliverable: Array<{ name: string; cSeq: number }> = [];
    const flags = { dead: true };
    const bus = lossySignaling(
      inMemory(),
      (data, opts) => flags.dead && opts.passive === true && frameTag(data) === "intent"
    );

    // Tight budget: base 25 ms + one retransmit → dead after ~75 ms of silence.
    const hostApp = makeApp(bus, { ackTimeoutMs: 25, maxRetransmits: 1 });
    const ctrlApp = makeApp(bus, { ackTimeoutMs: 25, maxRetransmits: 1 }, payload =>
      undeliverable.push(payload)
    );
    await hostApp.start();
    await ctrlApp.start();
    const { code } = hostApp.session.createRoom();
    await ctrlApp.session.joinRoom(code);

    try {
      hostApp.intent.register("lock", lockSchema);

      ctrlApp.intent.intent("lock", { qid: 1 }); // in flight — every transmission vanishes
      ctrlApp.intent.intent("lock", { qid: 2 }); // queued behind it — never transmitted

      await vi.waitFor(() =>
        expect(undeliverable).toEqual([
          { name: "lock", cSeq: 0 },
          { name: "lock", cSeq: 1 }
        ])
      );
    } finally {
      await hostApp.stop();
      await ctrlApp.stop();
    }
  });
});
