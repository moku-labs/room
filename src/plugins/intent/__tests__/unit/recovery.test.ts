/**
 * @file Unit tests for the intent plugin's `room:host-*` hooks over a fake `Wire`: the phone's live window
 * moves into the buffer when the host goes, and the buffer goes back through the delivery tracker when it
 * returns. The reloaded host hears `room:host-reconnecting` too, and must not start buffering.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Frame, PeerId, Wire } from "../../../transport/protocol";
import { createIntentApi } from "../../api";
import { createRecoveryHooks, endRoom } from "../../recovery";
import { createIntentState } from "../../state";
import type { IntentConfig } from "../../types";

/** The unsubscribe the fake wire's `on` returns. Nothing here unsubscribes. */
const noopUnsubscribe = (): void => {};

const config: IntentConfig = {
  bufferCap: 256,
  bufferMaxAgeMs: 10_000,
  ackTimeoutMs: 1000,
  maxRetransmits: 3
};

/**
 * A controller's intent state and API over a fake wire, plus its hooks.
 *
 * @param role - The session role the hooks read.
 * @returns The API, the state, the wire's `send` spy and the hooks.
 */
function makePhone(role: "controller" | "host" | "none" = "controller") {
  const state = createIntentState();
  const send = vi.fn<(peerId: PeerId, frame: Frame) => void>();
  const wire: Wire = { send, broadcast: vi.fn(), on: () => noopUnsubscribe };
  const api = createIntentApi(state, config, wire, () => "host-1", vi.fn());
  const hooks = createRecoveryHooks(state, config, () => role);
  return { api, state, send, hooks };
}

describe("intent recovery hooks", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("room:host-reconnecting moves the unacked live frame into the buffer and buffers what follows", () => {
    const { api, send, hooks } = makePhone();
    api.intent("tap", { n: 1 });
    send.mockClear();

    hooks["room:host-reconnecting"]();
    api.intent("tap", { n: 2 });

    expect(api.bufferedCount()).toBe(2);
    expect(send).not.toHaveBeenCalled();
  });

  it("room:host-back sends the buffer once, each frame keeping its cSeq, and intents go live again", () => {
    const { api, state, send, hooks } = makePhone();
    hooks["room:host-reconnecting"]();
    api.intent("tap", { n: 1 });
    api.intent("tap", { n: 2 });

    hooks["room:host-back"]();

    expect(state.buffering).toBe(false);
    expect(api.bufferedCount()).toBe(0);
    // Stop-and-wait: the first frame is on the wire, the second waits for its ack.
    expect(send.mock.calls).toEqual([
      ["host-1", expect.objectContaining({ t: "intent", cSeq: 0 })]
    ]);
    state.delivery?.onAck(0);
    expect(send.mock.calls[1]).toEqual([
      "host-1",
      expect.objectContaining({ t: "intent", cSeq: 1 })
    ]);
    state.delivery?.onAck(1);

    api.intent("tap", { n: 3 });
    expect(send.mock.calls[2]).toEqual([
      "host-1",
      expect.objectContaining({ t: "intent", cSeq: 2 })
    ]);
  });

  it("room:host-back sends in cSeq order when the clock stepped back between two intents", () => {
    vi.useFakeTimers({ now: 5000 });
    const { api, state, send, hooks } = makePhone();
    hooks["room:host-reconnecting"]();
    api.intent("tap", { n: 1 });
    vi.setSystemTime(4000);
    api.intent("tap", { n: 2 });

    hooks["room:host-back"]();
    state.delivery?.onAck(0);

    expect(send.mock.calls.map(([, frame]) => (frame as { cSeq: number }).cSeq)).toEqual([0, 1]);
  });

  it("endRoom turns buffering off and drops the buffer: the old room's frames never reach the next host", () => {
    const { api, state, send, hooks } = makePhone();
    hooks["room:host-reconnecting"]();
    api.intent("tap", { n: 1 });

    endRoom(state, config);

    expect(state.buffering).toBe(false);
    expect(api.bufferedCount()).toBe(0);
    expect(send).not.toHaveBeenCalled();

    api.intent("tap", { n: 2 });
    expect(send.mock.calls).toEqual([["host-1", expect.objectContaining({ cSeq: 1 })]]);
  });

  it("the reloaded host hears room:host-reconnecting and does not start buffering", () => {
    const { state, hooks } = makePhone("host");

    hooks["room:host-reconnecting"]();

    expect(state.buffering).toBe(false);
  });

  it("room:host-back on a device that is no controller sends nothing", () => {
    const { state, send, hooks } = makePhone("none");
    state.buffering = true;
    state.buffer.push({
      intent: { t: "intent", name: "tap", payload: {}, cSeq: 0 },
      ts: Date.now()
    });

    hooks["room:host-back"]();

    expect(send).not.toHaveBeenCalled();
    expect(state.buffer).toHaveLength(1);
  });
});
