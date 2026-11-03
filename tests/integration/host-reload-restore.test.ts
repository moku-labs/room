/**
 * @file A host reload with a phone in the room, through the public facades over the `inMemory` bus: the
 * phone's recovery events and intent buffer, the re-handshake, and the host's restored state. A "reload" is
 * `stop()` on the old app and a new `createApp` on the same bus and the same stubbed `localStorage`.
 *
 * Timing note: `inMemory` delivers frames on microtasks, so a phone's flushed intents reach the new host
 * before `await app.start()` returns. Each test registers the intent right after `createApp`, as a game
 * plugin's `onInit` does. A real channel delivers on a later task, after the boot code.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IntentMeta } from "../../src/plugins/intent/types";
import type { LoopbackSignaling } from "../../src/plugins/transport/channel";
import type { SignalingSession } from "../../src/plugins/transport/protocol";
import type { Bus, HeartbeatTimings } from "./helpers/harness";
import {
  countEvent,
  makeBus,
  makeController,
  makeStage,
  stubLocalStorage
} from "./helpers/harness";

/** Declares a lost host dead within 120 ms. */
const FAST_HEARTBEAT: HeartbeatTimings = { heartbeatIntervalMs: 25, heartbeatTimeoutMs: 120 };

/**
 * Opens a room with one saved round and a phone that has its replica.
 *
 * @param bus - The signaling bus of the room.
 * @param heartbeat - The phone's heartbeat timings.
 * @returns The host app and the phone app with its captured events.
 */
async function roomWithPhone(bus: Bus, heartbeat: HeartbeatTimings) {
  const { app: host } = makeStage(bus);
  await host.start();
  const { code } = host.stage.createRoom();
  host.sync.registerSlice("scores", { ann: 0 });
  host.stage.mutate("scores", scores => ({ ...scores, ann: 1 }));
  host.stage.broadcast();

  const { app: phone, captured } = makeController(bus, "phone", heartbeat);
  await phone.start();
  await phone.controller.joinRoom(code);
  await vi.waitFor(() => expect(phone.controller.read("scores")).toEqual({ ann: 1 }));
  return { host, phone, captured };
}

/**
 * Loads a host and records the `tap` intents it hands to its handler.
 *
 * @param bus - The signaling bus of the room.
 * @returns The host app and the `cSeq` of each tap its handler ran for.
 */
function hostWithTap(bus: Bus) {
  const { app: host } = makeStage(bus);
  const applied: number[] = [];
  host.intent.register("tap", { fields: { n: { type: "number" } }, additionalFields: false });
  host.intent.onIntent("tap", (_payload, meta: IntentMeta) => {
    applied.push(meta.cSeq);
  });
  return { host, applied };
}

/**
 * Wraps a bus so a host's `roster` frames vanish: a joining phone gets its channel and no verdict.
 *
 * @param bus - The signaling bus of the room.
 * @returns The bus for the host to use.
 */
function withoutRosterFrames(bus: Bus): Bus {
  return {
    async join(code, opts) {
      const session = (await bus.join(code, opts)) as SignalingSession & LoopbackSignaling;
      return {
        ...session,
        openWireChannel(peerId: string) {
          const channel = session.openWireChannel(peerId);
          if (channel) {
            const send = channel.send.bind(channel);
            channel.send = data => {
              if (!data.includes('"t":"roster"')) send(data);
            };
          }
          return channel;
        }
      };
    }
  };
}

/** The part of the `wire.send` spy {@link intentsSentTo} reads. */
type SendSpy = { mock: { calls: unknown[][] } };

/**
 * The `cSeq` of every intent frame a phone sent to one peer.
 *
 * @param send - The spy on the phone's `wire.send`.
 * @param peerId - The peer to count frames for.
 * @returns The `cSeq` values, in send order.
 */
function intentsSentTo(send: SendSpy, peerId: string): number[] {
  return send.mock.calls
    .filter(([to, frame]) => to === peerId && (frame as { t: string }).t === "intent")
    .map(([, frame]) => (frame as { cSeq: number }).cSeq);
}

describe("host reload with a phone in the room", () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = stubLocalStorage();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a mutate after the reload reaches the phone once they re-handshake", async () => {
    const bus = makeBus();
    const { host: first, phone } = await roomWithPhone(bus, FAST_HEARTBEAT);
    await first.stop();

    const { app: next } = makeStage(bus);
    await next.start();
    next.sync.registerSlice("scores", { ann: 0 });
    next.stage.mutate("scores", scores => ({ ...scores, ann: 2 }));
    next.stage.broadcast();

    await vi.waitFor(() => expect(phone.controller.read("scores")).toEqual({ ann: 2 }));
    expect(next.stage.roster().map(entry => entry.id)).toEqual([phone.session.self().selfId]);

    await phone.stop();
    await next.stop();
  });

  it("host lost: reconnecting, intents buffer, nothing on the wire. Host back: each sent once, in cSeq order", async () => {
    const bus = makeBus();
    const { host: first, phone, captured } = await roomWithPhone(bus, FAST_HEARTBEAT);
    await first.stop();

    await vi.waitFor(() => expect(countEvent(captured, "room:host-reconnecting")).toBe(1));
    expect(phone.session.recoveryPhase()).toBe("host-absent");

    const send = vi.spyOn(phone.transport.wire(), "send");
    phone.controller.intent("tap", { n: 1 });
    expect(phone.intent.bufferedCount()).toBe(1);
    expect(send).not.toHaveBeenCalled();
    phone.controller.intent("tap", { n: 2 });
    expect(phone.intent.bufferedCount()).toBe(2);
    expect(countEvent(captured, "room:host-back")).toBe(0);

    const { host: next, applied } = hostWithTap(bus);
    await next.start();

    await vi.waitFor(() => expect(applied).toEqual([0, 1]));
    expect(countEvent(captured, "room:host-back")).toBe(1);
    expect(countEvent(captured, "room:host-reconnecting")).toBe(1);
    expect(phone.session.recoveryPhase()).toBe("stable");
    expect(phone.session.hostId()).toBe(next.session.self().selfId);
    expect(phone.intent.bufferedCount()).toBe(0);
    expect(intentsSentTo(send, next.session.self().selfId)).toEqual([0, 1]);

    // Live again, and the new host still sees one stream.
    phone.controller.intent("tap", { n: 3 });
    await vi.waitFor(() => expect(applied).toEqual([0, 1, 2]));

    await phone.stop();
    await next.stop();
  });

  it("the new host connects before the heartbeat expires: events fire once and the intent in flight arrives once", async () => {
    const bus = makeBus();
    // Long enough for the new host to arrive first, short enough to see the expiry in the test.
    const heartbeat = { heartbeatIntervalMs: 25, heartbeatTimeoutMs: 300 };
    const { host: first, phone, captured } = await roomWithPhone(bus, heartbeat);
    await first.stop();

    // The phone does not know yet: this goes live, to the dead host.
    phone.controller.intent("tap", { n: 1 });
    expect(phone.intent.bufferedCount()).toBe(0);
    expect(countEvent(captured, "room:host-reconnecting")).toBe(0);

    const send = vi.spyOn(phone.transport.wire(), "send");
    const { host: next, applied } = hostWithTap(bus);
    await next.start();
    const nextId = next.session.self().selfId;

    await vi.waitFor(() => expect(applied).toEqual([0]));
    expect(phone.session.hostId()).toBe(nextId);
    expect(phone.session.recoveryPhase()).toBe("stable");
    expect(countEvent(captured, "room:host-reconnecting")).toBe(1);
    expect(countEvent(captured, "room:host-back")).toBe(1);

    // The heartbeat now declares the old host dead. That is old news, so nothing fires again.
    await new Promise<void>(resolve => setTimeout(resolve, 400));
    expect(phone.transport.peers()).toEqual([nextId]);
    expect(phone.session.hostId()).toBe(nextId);
    expect(phone.session.recoveryPhase()).toBe("stable");
    expect(countEvent(captured, "room:host-reconnecting")).toBe(1);
    expect(countEvent(captured, "room:host-back")).toBe(1);
    expect(intentsSentTo(send, nextId)).toEqual([0]);
    expect(applied).toEqual([0]);

    await phone.stop();
    await next.stop();
  });

  it("leave() during an absence: the next room's intent goes live, and no recovery event fires for it", async () => {
    const bus = makeBus();
    const { host: first, phone, captured } = await roomWithPhone(bus, FAST_HEARTBEAT);
    await first.stop();
    await vi.waitFor(() => expect(countEvent(captured, "room:host-reconnecting")).toBe(1));
    phone.controller.intent("tap", { n: 1 });
    expect(phone.intent.bufferedCount()).toBe(1);

    await phone.session.leave();

    expect(phone.intent.bufferedCount()).toBe(0);
    expect(countEvent(captured, "room:host-back")).toBe(0);

    // Another room, on another device: it must not resume the first host's record.
    store.clear();
    const { host: other, applied } = hostWithTap(bus);
    await other.start();
    await phone.controller.joinRoom(other.stage.createRoom().code);

    phone.controller.intent("tap", { n: 2 });

    await vi.waitFor(() => expect(applied).toEqual([1]));
    expect(phone.intent.bufferedCount()).toBe(0);
    expect(countEvent(captured, "room:host-reconnecting")).toBe(1);
    expect(countEvent(captured, "room:host-back")).toBe(0);

    await phone.stop();
    await other.stop();
  });

  it("a failed first join during an absence: the retry's intent goes live, and no recovery event fires for it", async () => {
    const bus = makeBus();
    const { app: first } = makeStage(withoutRosterFrames(bus));
    await first.start();
    const { code } = first.stage.createRoom();
    const { app: phone, captured } = makeController(bus, "phone", FAST_HEARTBEAT, 500);
    await phone.start();

    const joining = phone.session.joinRoom(code);
    await vi.waitFor(() => expect(phone.session.hostId()).toBe(first.session.self().selfId));
    await first.stop();
    await vi.waitFor(() => expect(countEvent(captured, "room:host-reconnecting")).toBe(1));
    phone.controller.intent("tap", { n: 1 });
    expect(phone.intent.bufferedCount()).toBe(1);

    await expect(joining).resolves.toEqual({ ok: false, reason: "unreachable" });

    // Already off when the caller sees the result: a retry made on it goes live.
    expect(phone.intent.bufferedCount()).toBe(0);
    expect(countEvent(captured, "room:host-back")).toBe(0);

    const { host: other, applied } = hostWithTap(bus);
    await other.start();
    const retry = await phone.session.joinRoom(other.stage.createRoom().code);
    expect(retry.ok).toBe(true);

    phone.controller.intent("tap", { n: 2 });

    await vi.waitFor(() => expect(applied).toEqual([1]));
    expect(phone.intent.bufferedCount()).toBe(0);
    expect(countEvent(captured, "room:host-reconnecting")).toBe(1);
    expect(countEvent(captured, "room:host-back")).toBe(0);

    await phone.stop();
    await other.stop();
  });
});
