/**
 * @file Integration tests — full createApp wiring over the inMemory adapter.
 * @see ../../index.ts
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { RoomEvents } from "../../../../config";
import { createApp, createPlugin } from "../../../../index";
import { inMemory } from "../../adapters/in-memory";
import { transportPlugin } from "../../index";
import type { Frame, IntentFrame, Snapshot } from "../../protocol";

// ─────────────────────────────────────────────────────────────────────────────
// A pair of apps share ONE inMemory bus instance, so a host + a controller can
// rendezvous in-process with no real RTCPeerConnection.
// ─────────────────────────────────────────────────────────────────────────────

const CODE = "K7M2QX";

/** Captures `room:network-warning` reasons via a real Moku hook (the emit plane). */
const warnings: string[] = [];
const warningProbePlugin = createPlugin("warningProbe", {
  depends: [transportPlugin],
  createState: (): Record<string, never> => ({}),
  api: (): Record<string, never> => ({}),
  hooks: () => ({
    "room:network-warning": (payload: RoomEvents["room:network-warning"]) => {
      warnings.push(payload.reason);
    }
  })
});

/** Build a Room app on a given inMemory bus, optionally tuning heartbeat timings. */
function makeApp(
  signaling: ReturnType<typeof inMemory>,
  extra?: { heartbeatIntervalMs?: number; heartbeatTimeoutMs?: number }
) {
  return createApp({
    plugins: [warningProbePlugin],
    pluginConfigs: {
      transport: { signaling, ...extra }
    }
  });
}

/** Connect a host + controller on a shared bus and wait until each sees the other. */
async function connectPair(): Promise<{
  host: ReturnType<typeof makeApp>;
  ctrl: ReturnType<typeof makeApp>;
}> {
  const bus = inMemory();
  const host = makeApp(bus);
  const ctrl = makeApp(bus);
  await host.start();
  await ctrl.start();
  await host.transport.connect({ role: "host", selfId: "host_root", code: CODE });
  await ctrl.transport.connect({ role: "controller", selfId: "p_ab12", code: CODE });
  await vi.waitFor(() => {
    expect(host.transport.peers()).toContain("p_ab12");
    expect(ctrl.transport.peers()).toContain("host_root");
  });
  return { host, ctrl };
}

afterEach(() => {
  warnings.length = 0;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("transport integration (inMemory)", () => {
  it("app.start() runs onStart but opens NO connections at boot", async () => {
    const app = makeApp(inMemory());
    await app.start();
    expect(app.transport.peers()).toEqual([]);
    await app.stop();
  });

  it("a controller connect makes both peers() lists reflect the link", async () => {
    const { host, ctrl } = await connectPair();
    expect(host.transport.peers()).toEqual(["p_ab12"]);
    expect(ctrl.transport.peers()).toEqual(["host_root"]);
    await host.stop();
    await ctrl.stop();
  });

  it("a controller wire().send is delivered to the host's Wire.on consumer as the exact IntentFrame", async () => {
    const { host, ctrl } = await connectPair();

    const received: { peerId: string; frame: Frame }[] = [];
    host.transport.wire().on((peerId, frame) => received.push({ peerId, frame }));

    const intent: IntentFrame = { t: "intent", name: "move", payload: { x: 3 }, cSeq: 1 };
    ctrl.transport.wire().send("host_root", intent);

    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]?.peerId).toBe("p_ab12");
    expect(received[0]?.frame).toEqual(intent);

    await host.stop();
    await ctrl.stop();
  });

  it("a host broadcast reaches the controller", async () => {
    const { host, ctrl } = await connectPair();
    const received: Frame[] = [];
    ctrl.transport.wire().on((_peerId, frame) => received.push(frame));

    const delta: Frame = {
      t: "sync-delta",
      ops: [{ ns: "scores", key: "p1", val: 10 }],
      sSeq: 5
    };
    host.transport.wire().broadcast(delta);

    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toEqual(delta);

    await host.stop();
    await ctrl.stop();
  });

  it("chunked snapshots reassemble end-to-end across the inMemory pair", async () => {
    const { host, ctrl } = await connectPair();
    const received: Frame[] = [];
    ctrl.transport.wire().on((_peerId, frame) => received.push(frame));

    // A snapshot far larger than the 14 KiB chunk threshold.
    const big: Snapshot = { board: { blob: "z".repeat(40_000), n: 7 } };
    const snap: Frame = { t: "sync-snap", snapshot: big, sSeq: 0 };
    host.transport.wire().broadcast(snap);

    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toEqual(snap);

    await host.stop();
    await ctrl.stop();
  });

  it("app.stop() closes everything and leaves the session", async () => {
    const { host, ctrl } = await connectPair();
    await host.stop();
    expect(host.transport.peers()).toEqual([]);
    await ctrl.stop();
  });

  it("with two apps connected on one bus, hostApp.stop() leaves the controller app untouched (D14)", async () => {
    const { host, ctrl } = await connectPair();

    const ctrlPeersBefore = ctrl.transport.peers();
    await host.stop();

    // The controller instance is untouched: its peer roster is intact, proving onStop
    // recovered host state via teardownRegistry.get(ctx.global), not a shared singleton.
    expect(ctrl.transport.peers()).toEqual(ctrlPeersBefore);
    expect(ctrl.transport.peers()).toContain("host_root");

    await ctrl.stop();
  });

  it("a forced dead peer emits exactly one {reason:'channel-closed'} (de-dup)", async () => {
    vi.useFakeTimers();
    const bus = inMemory();
    const host = makeApp(bus, { heartbeatIntervalMs: 100, heartbeatTimeoutMs: 300 });
    const ctrl = makeApp(bus);

    await host.start();
    await ctrl.start();
    await host.transport.connect({ role: "host", selfId: "host_root", code: CODE });
    await ctrl.transport.connect({ role: "controller", selfId: "p_ab12", code: CODE });
    await vi.waitFor(() => expect(host.transport.peers()).toContain("p_ab12"));

    // Tear down the controller so it stops ponging, then let the host heartbeat
    // declare it dead across several ticks.
    await ctrl.transport.close();
    await vi.advanceTimersByTimeAsync(1000);

    expect(warnings.filter(reason => reason === "channel-closed")).toHaveLength(1);

    await host.stop();
    await ctrl.stop();
  });
});
