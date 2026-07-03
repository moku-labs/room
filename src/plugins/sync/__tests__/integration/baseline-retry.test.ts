/**
 * Integration tests for the not-ready baseline retry loop via `createApp` + the `inMemory` signaling
 * adapter (D13): a real stage + controller pair over an in-process wire whose loopback channels are
 * wrapped to DROP host-outbound `sync-snap` frames — the same at-most-once loss point a half-open
 * `RTCDataChannel` has. Covers the pre-game join wedge end-to-end: a controller whose join/late-join
 * baseline vanishes, with ZERO sync mutations following (an idle lobby), self-heals through the timed
 * `sync-resync` → baseline-answer loop instead of wedging un-ready until a page reload. Also covers the
 * slice-less-host shape: a controller that joins BEFORE the host registers any slice keeps asking until
 * a baseline exists.
 *
 * @file
 * @see ../../engine.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, createPlugin } from "../../../../index";
import { inMemory } from "../../../transport/adapters/in-memory";
import type { LoopbackSignaling, WireChannel } from "../../../transport/channel";
import type { Signaling, SignalingJoinOpts, SignalingSession } from "../../../transport/protocol";
import { syncPlugin } from "../../index";

// ---------------------------------------------------------------------------
// Test helpers — a lossy wrapper over the inMemory loopback channels
// (reference implementation: ../../../intent/__tests__/integration/delivery.test.ts)
// ---------------------------------------------------------------------------

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

/** Builds a sync-capable app over the (possibly lossy) signaling, with a fast baseline-retry cadence. */
function makeApp(signaling: Signaling, onSyncReady?: () => void) {
  // Per-test probe plugin: the app-level subscriber for the ONE event syncPlugin owns.
  const probePlugin = createPlugin("probe", {
    depends: [syncPlugin],
    hooks: () => ({
      "room:sync-ready": () => onSyncReady?.()
    })
  });
  return createApp({
    plugins: [probePlugin],
    pluginConfigs: {
      transport: { signaling },
      session: { generateQr: false, reconnectTimeoutMs: 10_000 },
      sync: { baselineRetryMs: 50 }
    }
  });
}

// ---------------------------------------------------------------------------
// The pre-game join wedge: baseline sync-snap lost, zero deltas following
// ---------------------------------------------------------------------------

describe("sync baseline retry — a dropped join baseline over a lossy inMemory wire", () => {
  const flags = { dropSnaps: false };
  let hostApp: ReturnType<typeof makeApp>;
  let ctrlApp: ReturnType<typeof makeApp>;
  let ctrlSyncReady: ReturnType<typeof vi.fn<() => void>>;

  /** Host→controller `sync-snap` frames drop while `dropSnaps` (controllers join `passive: true`). */
  const shouldDrop: DropPredicate = (data, opts) =>
    flags.dropSnaps && opts.passive !== true && frameTag(data) === "sync-snap";

  beforeEach(async () => {
    flags.dropSnaps = false;
    ctrlSyncReady = vi.fn<() => void>();
    const bus = lossySignaling(inMemory(), shouldDrop);
    hostApp = makeApp(bus);
    ctrlApp = makeApp(bus, ctrlSyncReady);
    await hostApp.start();
    await ctrlApp.start();
  });

  afterEach(async () => {
    await hostApp.stop();
    await ctrlApp.stop();
  });

  it("a controller whose join baseline vanished self-heals with ZERO mutations (idle lobby)", async () => {
    // Lobby state exists BEFORE the controller joins — and no mutation ever follows, so no delta can
    // trigger the gap heal. Only the timed baseline re-request can save the replica.
    const { code } = hostApp.session.createRoom();
    hostApp.sync.registerSlice("lobby", { phase: "waiting" });

    // The wire goes half-open for the host's outbound snapshots: the room:peer-joined baseline AND
    // every answering re-baseline vanish — the exact shape behind the pre-game join wedge.
    flags.dropSnaps = true;
    await ctrlApp.session.joinRoom(code);
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(ctrlApp.sync.isReady()).toBe(false);
    expect(ctrlSyncReady).not.toHaveBeenCalled();

    // The channel recovers: the next timed sync-resync is answered with a fresh baseline — the replica
    // becomes readable without a reload and room:sync-ready fires exactly once.
    flags.dropSnaps = false;
    await vi.waitFor(() => expect(ctrlApp.sync.isReady()).toBe(true));
    expect(ctrlApp.sync.read("lobby")).toEqual({ phase: "waiting" });
    expect(ctrlSyncReady).toHaveBeenCalledTimes(1);
  });

  it("a controller that joined BEFORE any slice existed keeps asking until the host registers one", async () => {
    // The controller joins a slice-less host: the room:peer-joined baseline is a no-op (nothing to
    // send), and with zero mutations there is no bootstrap delta either.
    const { code } = hostApp.session.createRoom();
    await ctrlApp.session.joinRoom(code);
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(ctrlApp.sync.isReady()).toBe(false);

    // The host finally registers its first slice — no mutate, no broadcast (a silent lobby). The
    // controller's next timed ask is answered with the fresh baseline.
    hostApp.sync.registerSlice("lobby", { phase: "waiting" });
    await vi.waitFor(() => expect(ctrlApp.sync.isReady()).toBe(true));
    expect(ctrlApp.sync.read("lobby")).toEqual({ phase: "waiting" });
    expect(ctrlSyncReady).toHaveBeenCalledTimes(1);
  });
});
