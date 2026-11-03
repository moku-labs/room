/**
 * @file Integration tests for the host re-entry record, on the real stage app: `sync` hands the snapshot to
 * `session.persistSnapshot`, and `session` writes the record to a stubbed `localStorage`. A "load" is a new
 * `createApp` on the same bus and the same storage. `leave()` ends the room for good, `stop()` is the reload
 * path. `sync` only persists after a dirty slice and a broadcast, so every scenario plays one round first.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeBus,
  makeController,
  makeServerBus,
  makeStage,
  sawEvent
} from "../../../../../tests/integration/helpers/harness";
import { sessionConfig } from "../../config";

/** Gives sync a dirty slice and a broadcast: the only way a real app writes a record. */
function playOneRound(app: ReturnType<typeof makeStage>["app"]): void {
  app.sync.registerSlice("scores", { ann: 0 });
  app.stage.mutate("scores", scores => ({ ...scores, ann: 1 }));
  app.stage.broadcast();
}

/** A first load on a hub: leaves a record that carries a reclaim token behind. */
async function leaveRecordWithToken(): Promise<void> {
  const { app: first } = makeStage(makeServerBus());
  await first.start();
  first.stage.createRoom();
  await vi.waitFor(() => expect(first.transport.reclaimToken()).not.toBeNull());
  playOneRound(first);
  await first.stop();
}

describe("host re-entry record", () => {
  let store: Map<string, string>;

  /** The re-entry keys in the stubbed storage. */
  const reentryKeys = (): string[] => [...store.keys()].filter(key => key.includes(".reentry."));

  beforeEach(() => {
    store = new Map();
    vi.stubGlobal("localStorage", {
      get length(): number {
        return store.size;
      },
      key: (index: number): string | null => [...store.keys()][index] ?? null,
      getItem: (key: string): string | null => store.get(key) ?? null,
      setItem: (key: string, value: string): void => {
        store.set(key, value);
      },
      removeItem: (key: string): void => {
        store.delete(key);
      }
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("leave() writes no record: the next load has role none and createRoom gives a new code", async () => {
    const bus = makeBus();
    const { app: first } = makeStage(bus);
    await first.start();
    const { code } = first.stage.createRoom();
    playOneRound(first);

    await first.session.leave();
    expect(reentryKeys()).toEqual([]);
    await first.stop();
    expect(reentryKeys()).toEqual([]);

    const { app: next } = makeStage(bus);
    await next.start();
    expect(next.session.self().role).toBe("none");
    expect(next.stage.createRoom().code).not.toBe(code);
    await next.stop();
  });

  it("stop() keeps the record: the next load's createRoom returns the same room, then throws", async () => {
    const bus = makeBus();
    const { app: first } = makeStage(bus);
    await first.start();
    const room = first.stage.createRoom();
    playOneRound(first);

    await first.stop();
    expect(reentryKeys()).toEqual([`moku.room.reentry.${room.code}`]);

    const join = vi.spyOn(bus, "join");
    const { app: next } = makeStage(bus);
    await next.start();

    expect(next.stage.createRoom()).toEqual(room);
    expect(() => next.stage.createRoom()).toThrow("A room is already active");
    // The reload joined the room once. A second connect would first leave that session, so its join comes
    // a tick later: wait for it before counting.
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(join).toHaveBeenCalledTimes(1);
    await next.stop();
  });

  it("createRoom after leave() admits a controller and hears its frames (the wiring survives close)", async () => {
    const bus = makeBus();
    const { app: host, captured } = makeStage(bus);
    await host.start();
    host.stage.createRoom();
    playOneRound(host);
    await host.session.leave();

    const { code } = host.stage.createRoom();
    const senders: string[] = [];
    host.intent.register("tap", {
      fields: { value: { type: "number", min: 0, max: 100 } },
      additionalFields: true
    });
    host.stage.onIntent("tap", (_payload, peerId) => {
      senders.push(peerId);
    });

    const { app: phone } = makeController(bus, "phoneAfterLeave");
    await phone.start();
    await phone.controller.joinRoom(code);

    await vi.waitFor(() => expect(host.stage.roster()).toHaveLength(1));
    expect(sawEvent(captured, "room:peer-joined")).toBe(true);

    phone.controller.intent("tap", { value: 1 });
    await vi.waitFor(() => expect(senders).toEqual([phone.session.self().selfId]));

    await phone.stop();
    await host.stop();
  });

  it("an idle room older than the max age, flushed at the stop, restores on the next load", async () => {
    const bus = makeBus();
    const { app: first } = makeStage(bus);
    await first.start();
    const { code } = first.stage.createRoom();
    playOneRound(first);
    await first.stop();

    // This load changes nothing, so sync hands session no new record.
    const { app: idle } = makeStage(bus);
    await idle.start();
    expect(idle.session.self().roomCode).toBe(code);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + sessionConfig.reentryMaxAgeMs + 1000);
    await idle.stop();

    const { app: next } = makeStage(bus);
    await next.start();
    expect(next.session.self().roomCode).toBe(code);
    await next.stop();
  });

  it("the hub refused the reclaim: the next load joins the same code again, with a fresh token", async () => {
    const { app: first } = makeStage(makeServerBus());
    await first.start();
    const { code } = first.stage.createRoom();
    await vi.waitFor(() => expect(first.transport.reclaimToken()).not.toBeNull());
    playOneRound(first);
    const oldToken = first.transport.reclaimToken();
    await first.stop();

    // A new bus knows no token, as a hub does after it evicted the room.
    const evicted = makeServerBus();
    const join = vi.spyOn(evicted, "join");
    const { app: next } = makeStage(evicted);
    await next.start();

    await vi.waitFor(() => expect(next.transport.reclaimToken()).not.toBeNull());
    expect(next.transport.reclaimToken()).not.toBe(oldToken);
    expect(next.session.self().roomCode).toBe(code);
    const selfId = next.session.self().selfId;
    expect(join.mock.calls).toEqual([
      [code, { selfId, passive: false, reclaimToken: oldToken }],
      [code, { selfId, passive: false }]
    ]);

    await next.stop();
  });

  it("a refused reclaim whose fresh join works fires no room:network-warning", async () => {
    await leaveRecordWithToken();

    // A new bus knows no token, as a hub does after it evicted the room.
    const { app: next, captured } = makeStage(makeServerBus());
    await next.start();
    await vi.waitFor(() => expect(next.transport.reclaimToken()).not.toBeNull());

    expect(sawEvent(captured, "room:network-warning")).toBe(false);

    await next.stop();
  });

  it("a refused reclaim whose fresh join fails too fires rendezvous-unreachable once", async () => {
    await leaveRecordWithToken();

    const down = makeServerBus();
    const join = vi.spyOn(down, "join").mockRejectedValue(new Error("hub down"));
    const { app: next, captured } = makeStage(down);
    await next.start();
    await vi.waitFor(() => expect(join).toHaveBeenCalledTimes(2));
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(captured.filter(event => event.name === "room:network-warning")).toEqual([
      { name: "room:network-warning", payload: { reason: "rendezvous-unreachable" } }
    ]);

    await next.stop();
  });

  it("an idle host killed right after a refused reclaim: the next load reclaims with the new token, and nothing is refused", async () => {
    await leaveRecordWithToken();

    const evicted = makeServerBus();
    const { app: idle } = makeStage(evicted);
    await idle.start();
    await vi.waitFor(() => expect(idle.transport.reclaimToken()).not.toBeNull());
    const newToken = idle.transport.reclaimToken();

    // The tab dies here: its socket goes with no stop and no visibilitychange, so storage holds only what the retry wrote.
    await idle.transport.close();

    const join = vi.spyOn(evicted, "join");
    const { app: next } = makeStage(evicted);
    await next.start();
    await vi.waitFor(() => expect(next.transport.reclaimToken()).toBe(newToken));

    expect(join).toHaveBeenCalledOnce();
    expect(join.mock.calls[0]?.[1]).toMatchObject({ reclaimToken: newToken });

    await next.stop();
    await idle.stop();
  });

  it("leave() after a reload removes the key and ends the restored room", async () => {
    const bus = makeBus();
    const { app: first } = makeStage(bus);
    await first.start();
    const { code } = first.stage.createRoom();
    playOneRound(first);
    await first.stop();

    const { app: reloaded } = makeStage(bus);
    await reloaded.start();
    expect(reloaded.session.self().roomCode).toBe(code);

    await reloaded.session.leave();
    expect(reentryKeys()).toEqual([]);

    // leave() dropped the restored room: this mints a new one, and the next call refuses as usual.
    expect(reloaded.stage.createRoom().code).not.toBe(code);
    expect(() => reloaded.stage.createRoom()).toThrow("A room is already active");
    await reloaded.stop();
  });
});
