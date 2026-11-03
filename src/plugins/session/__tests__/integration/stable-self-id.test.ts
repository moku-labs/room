/**
 * @file Integration tests for a phone's stable `selfId`, on the real stage and controller apps over the
 * `inMemory` bus. A "tab" is a `sessionStorage` stub: a reload is a new `createApp` with the SAME tab, a second
 * player is a new `createApp` with its OWN tab. A stubbed global holds one tab at a time, so every phone acts
 * in turn, through `inTab`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type Bus,
  countEvent,
  makeBus,
  makeController,
  makeServerBus,
  makeStage,
  sawEvent
} from "../../../../../tests/integration/helpers/harness";
import type { RoomEvents } from "../../../../config";
import { createApp, createPlugin, stagePlugin } from "../../../../index";
import { MAX_CONTROLLERS, RoomFullError } from "../../../transport/protocol";

/** Long enough for a real join, short enough that a join nobody answers fails the test quickly. */
const JOIN_TIMEOUT_MS = 1000;

/** A mock `sessionStorage` over a `Map`, the shape `recovery-persistence.test.ts` uses for `localStorage`. */
class TabStorage {
  private readonly store = new Map<string, string>();

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  /** The keys in this tab. */
  keys(): string[] {
    return [...this.store.keys()];
  }
}

/**
 * Makes `tab` the storage this process sees, then runs `act`.
 *
 * @param tab - The tab the phone lives in.
 * @param act - What the phone does there.
 * @returns What `act` returned.
 */
function inTab<T>(tab: TabStorage, act: () => T): T {
  vi.stubGlobal("sessionStorage", tab);
  return act();
}

/**
 * The `sessionStorage` key of one room.
 *
 * @param code - The room code.
 * @returns The key, with the default prefix.
 */
const selfKey = (code: string): string => `moku.room.self.${code}`;

/**
 * Lets the hooks of an emit run, so a test can also assert that nothing more arrived.
 *
 * @returns A promise that resolves a few milliseconds later.
 */
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 5));

/**
 * Builds a started phone whose join gives up after {@link JOIN_TIMEOUT_MS}.
 *
 * @param bus - The signaling bus to rendezvous on.
 * @param name - A unique probe name.
 * @returns The started phone app.
 */
async function startPhone(bus: Bus, name: string) {
  const { app } = makeController(bus, name, undefined, JOIN_TIMEOUT_MS);
  await app.start();
  return app;
}

/**
 * Builds a started stage with one seat, holding an open room with its seat taken.
 *
 * @param bus - The signaling bus to rendezvous on.
 * @returns The stage app, the room code and the seated phone.
 */
async function fullOneSeatRoom(bus: Bus) {
  const stage = createApp({
    plugins: [stagePlugin],
    pluginConfigs: {
      transport: { signaling: bus },
      session: { generateQr: false, maxControllers: 1 }
    }
  });
  await stage.start();
  const { code } = stage.stage.createRoom();
  const seated = await startPhone(bus, "seated");
  await inTab(new TabStorage(), () => seated.session.joinRoom(code));
  return { stage, code, seated };
}

/**
 * Replaces `RTCPeerConnection` with a double whose handshake never finishes by itself, so a test decides when a
 * channel opens and when a handshake dies.
 *
 * @returns The `open` listener of every data channel created, in creation order.
 */
function stubRtc(): (() => void)[] {
  const opens: (() => void)[] = [];
  class FakePc {
    iceConnectionState = "new";
    onicecandidate = null;
    oniceconnectionstatechange = null;
    createDataChannel() {
      return {
        readyState: "open",
        bufferedAmount: 0,
        bufferedAmountLowThreshold: 0,
        onmessage: null,
        send: vi.fn(),
        close: vi.fn(),
        removeEventListener: vi.fn(),
        addEventListener: (type: string, cb: () => void): void => {
          if (type === "open") opens.push(cb);
        }
      };
    }
    async createOffer() {
      return { type: "offer", sdp: "v=0" };
    }
    async setLocalDescription() {}
    close() {}
  }
  vi.stubGlobal("RTCPeerConnection", FakePc);
  return opens;
}

/**
 * Builds a started stage on the server-mode bus, the real WebRTC path, with an open room.
 *
 * @param openTimeoutMs - How long each handshake attempt waits for its channel.
 * @returns The bus, the stage, the room code and what the stage's consumers heard.
 */
async function realPathStage(openTimeoutMs: number) {
  const bus = makeServerBus();
  const joined: string[] = [];
  const left: string[] = [];
  const warnings: string[] = [];
  const probe = createPlugin("realPathProbe", {
    depends: [stagePlugin],
    createState: (): Record<string, never> => ({}),
    api: (): Record<string, never> => ({}),
    hooks: () => ({
      "room:peer-joined": (payload: RoomEvents["room:peer-joined"]): void => {
        joined.push(payload.peerId);
      },
      "room:peer-left": (payload: RoomEvents["room:peer-left"]): void => {
        left.push(payload.peerId);
      },
      "room:network-warning": (payload: RoomEvents["room:network-warning"]): void => {
        warnings.push(payload.reason);
      }
    })
  });
  const stage = createApp({
    plugins: [stagePlugin, probe],
    pluginConfigs: {
      transport: { signaling: bus, openTimeoutMs },
      session: { generateQr: false }
    }
  });
  await stage.start();
  const { code } = stage.stage.createRoom();
  // The host's signaling session is live once it holds its reclaim token.
  await vi.waitFor(() => expect(stage.transport.reclaimToken()).not.toBeNull());
  return { bus, stage, code, joined, left, warnings };
}

describe("a phone's stable selfId", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a reloaded phone's intent reaches the host's handler, though its cSeq starts at 0 again", async () => {
    const bus = makeBus();
    const { app: stage } = makeStage(bus);
    await stage.start();
    const { code } = stage.stage.createRoom();
    const taps: unknown[] = [];
    stage.intent.register("tap", {
      fields: { value: { type: "number", min: 0, max: 100 } },
      additionalFields: true
    });
    stage.stage.onIntent("tap", payload => {
      taps.push(payload);
    });

    const tab = new TabStorage();
    const before = await startPhone(bus, "tapperBefore");
    await inTab(tab, () => before.session.joinRoom(code));
    before.controller.intent("tap", { value: 1 });
    before.controller.intent("tap", { value: 2 });
    await vi.waitFor(() => expect(taps).toHaveLength(2));
    await before.stop();

    const after = await startPhone(bus, "tapperAfter");
    await inTab(tab, () => after.session.joinRoom(code));
    after.controller.intent("tap", { value: 3 });

    await vi.waitFor(() => expect(taps.at(-1)).toEqual({ value: 3 }));

    await after.stop();
    await stage.stop();
  });

  it("real path: a replacement that opens keeps the entry, sends no peer-left, and joins again", async () => {
    const opens = stubRtc();
    const { bus, stage, code, joined, left } = await realPathStage(10_000);
    await bus.join(code, { selfId: "phone", passive: true });
    opens.at(-1)?.();
    const roster = stage.stage.roster();
    expect(roster).toHaveLength(1);

    await bus.join(code, { selfId: "phone", passive: true });
    await settle();
    opens.at(-1)?.();
    await settle();

    expect(opens).toHaveLength(2);
    expect(stage.stage.roster()).toEqual(roster);
    expect(left).toEqual([]);
    expect(joined).toEqual(["phone", "phone"]);

    await stage.stop();
  });

  it("real path: a replacement that gives up past the retry cap removes the entry, with one peer-left", async () => {
    const opens = stubRtc();
    const { bus, stage, code, left } = await realPathStage(5);
    await bus.join(code, { selfId: "phone", passive: true });
    opens.at(-1)?.();
    expect(stage.stage.roster()).toHaveLength(1);

    await bus.join(code, { selfId: "phone", passive: true });

    await vi.waitFor(() => expect(stage.stage.roster()).toEqual([]));
    await settle();
    expect(left).toEqual(["phone"]);

    await stage.stop();
  });

  it("real path: a replacement that leaves signaling mid-handshake removes the entry, with one peer-left", async () => {
    const opens = stubRtc();
    const { bus, stage, code, left } = await realPathStage(10_000);
    await bus.join(code, { selfId: "phone", passive: true });
    opens.at(-1)?.();
    expect(stage.stage.roster()).toHaveLength(1);

    const back = await bus.join(code, { selfId: "phone", passive: true });
    await back.leave();
    await settle();

    expect(stage.stage.roster()).toEqual([]);
    expect(left).toEqual(["phone"]);

    await stage.stop();
  });

  it("real path: a peer that never reached the roster causes no peer-left, on either way out", async () => {
    stubRtc();
    const gaveUp = await realPathStage(5);
    await gaveUp.bus.join(gaveUp.code, { selfId: "stranger", passive: true });
    await vi.waitFor(() => expect(gaveUp.warnings).toEqual(["ice-failed"]));
    await settle();
    expect(gaveUp.left).toEqual([]);
    await gaveUp.stage.stop();

    const walkedOff = await realPathStage(10_000);
    const stranger = await walkedOff.bus.join(walkedOff.code, {
      selfId: "stranger",
      passive: true
    });
    await stranger.leave();
    await settle();
    expect(walkedOff.left).toEqual([]);
    await walkedOff.stage.stop();
  });

  it("a reload keeps the id and the roster entry: no room:peer-left, and the new replica gets a baseline", async () => {
    const bus = makeBus();
    const { app: stage, captured } = makeStage(bus);
    await stage.start();
    const { code } = stage.stage.createRoom();
    stage.sync.registerSlice("scores", { ann: 0 });
    stage.stage.mutate("scores", scores => ({ ...scores, ann: 1 }));
    stage.stage.broadcast();

    const tab = new TabStorage();
    const before = await startPhone(bus, "beforeReload");
    await inTab(tab, () => before.session.joinRoom(code));
    const neighbour = await startPhone(bus, "neighbour");
    await inTab(new TabStorage(), () => neighbour.session.joinRoom(code));

    const selfId = before.session.self().selfId;
    const roster = stage.stage.roster();
    expect(roster).toHaveLength(2);

    // The page goes with no leave(). The wait makes a re-stamped joinedAt differ from the first one.
    await before.stop();
    await new Promise<void>(resolve => setTimeout(resolve, 2));

    const after = await startPhone(bus, "afterReload");
    const result = await inTab(tab, () => after.session.joinRoom(code));

    expect(result).toEqual({ ok: true, selfId });
    expect(stage.stage.roster()).toEqual(roster);
    expect(sawEvent(captured, "room:peer-left")).toBe(false);
    // room:peer-joined fires again for the known id: it is what sends the new replica its baseline.
    expect(countEvent(captured, "room:peer-joined")).toBe(3);
    await vi.waitFor(() => expect(after.controller.read("scores")).toEqual({ ann: 1 }));

    await after.stop();
    await neighbour.stop();
    await stage.stop();
  });

  it("a reload at the cap of 8 is admitted", async () => {
    const bus = makeBus();
    const { app: stage, captured } = makeStage(bus);
    await stage.start();
    const { code } = stage.stage.createRoom();

    const tabs = Array.from({ length: MAX_CONTROLLERS }, () => new TabStorage());
    const phones = [];
    for (const [index, tab] of tabs.entries()) {
      const phone = await startPhone(bus, `seat${index}`);
      await inTab(tab, () => phone.session.joinRoom(code));
      phones.push(phone);
    }
    expect(stage.stage.roster()).toHaveLength(MAX_CONTROLLERS);

    const [first, ...others] = phones;
    const selfId = first?.session.self().selfId;
    await first?.stop();

    const after = await startPhone(bus, "reloadAtCap");
    const result = await inTab(tabs[0] as TabStorage, () => after.session.joinRoom(code));

    expect(result).toEqual({ ok: true, selfId });
    expect(stage.stage.roster()).toHaveLength(MAX_CONTROLLERS);
    expect(sawEvent(captured, "room:peer-left")).toBe(false);

    await Promise.all([after, ...others].map(phone => phone.stop()));
    await stage.stop();
  });

  it("two apps with separate sessionStorage are two players", async () => {
    const bus = makeBus();
    const { app: stage } = makeStage(bus);
    await stage.start();
    const { code } = stage.stage.createRoom();

    const one = await startPhone(bus, "tabOne");
    const two = await startPhone(bus, "tabTwo");
    await inTab(new TabStorage(), () => one.session.joinRoom(code));
    await inTab(new TabStorage(), () => two.session.joinRoom(code));

    const ids = stage.stage.roster().map(entry => entry.id);
    expect(ids).toHaveLength(2);
    expect(ids).toContain(one.session.self().selfId);
    expect(ids).toContain(two.session.self().selfId);

    await one.stop();
    await two.stop();
    await stage.stop();
  });

  it("leave() removes the saved id, and the next join is a new player", async () => {
    const bus = makeBus();
    const { app: stage } = makeStage(bus);
    await stage.start();
    const { code } = stage.stage.createRoom();

    const tab = new TabStorage();
    const phone = await startPhone(bus, "leaver");
    await inTab(tab, () => phone.session.joinRoom(code));
    const selfId = phone.session.self().selfId;
    expect(tab.getItem(selfKey(code))).toBe(selfId);

    await inTab(tab, () => phone.session.leave());
    expect(tab.keys()).toEqual([]);

    await inTab(tab, () => phone.session.joinRoom(code));
    expect(phone.session.self().selfId).not.toBe(selfId);

    await phone.stop();
    await stage.stop();
  });

  it("a full result removes the saved id, and a retry inside the close delay gets full too", async () => {
    const bus = makeBus();
    const { stage, code, seated } = await fullOneSeatRoom(bus);

    const tab = new TabStorage();
    const refused = await startPhone(bus, "refused");
    await expect(inTab(tab, () => refused.session.joinRoom(code))).resolves.toEqual({
      ok: false,
      reason: "full"
    });
    expect(tab.keys()).toEqual([]);

    // The host holds the refused peer for 250 ms after its room-full frame: this retry lands inside that.
    const refusedId = refused.session.self().selfId;
    expect(stage.transport.peers()).toContain(refusedId);
    await expect(inTab(tab, () => refused.session.joinRoom(code))).resolves.toEqual({
      ok: false,
      reason: "full"
    });
    expect(refused.session.self().selfId).not.toBe(refusedId);

    await refused.stop();
    await seated.stop();
    await stage.stop();
  });

  it("the same id back inside the close delay gets full, not a silent timeout", async () => {
    const bus = makeBus();
    const { stage, code, seated } = await fullOneSeatRoom(bus);

    const tab = new TabStorage();
    const refused = await startPhone(bus, "refusedTwice");
    await inTab(tab, () => refused.session.joinRoom(code));
    const refusedId = refused.session.self().selfId;

    // A reload that beat the room-full frame: the key survived, so the host sees the id it still holds.
    tab.setItem(selfKey(code), refusedId);
    expect(stage.transport.peers()).toContain(refusedId);
    await expect(inTab(tab, () => refused.session.joinRoom(code))).resolves.toEqual({
      ok: false,
      reason: "full"
    });
    expect(refused.session.self().selfId).toBe(refusedId);

    await refused.stop();
    await seated.stop();
    await stage.stop();
  });

  it("the hub's full removes the saved id too", async () => {
    const refusing: Bus = { join: () => Promise.reject(new RoomFullError()) };
    const tab = new TabStorage();
    const phone = await startPhone(refusing, "refusedByHub");

    await expect(inTab(tab, () => phone.session.joinRoom("K7M2QX"))).resolves.toEqual({
      ok: false,
      reason: "full"
    });
    expect(tab.keys()).toEqual([]);

    await phone.stop();
  });
});
