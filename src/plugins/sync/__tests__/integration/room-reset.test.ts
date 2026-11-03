/**
 * @file Integration tests for what `sync` holds when a room ends, on the real stage and controller apps over the
 * `inMemory` bus. A host's slices stay registered and go back to their initial value. A phone's replica empties, so
 * its next room starts as its first one did.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  countEvent,
  makeBus,
  makeController,
  makeStage,
  stubLocalStorage
} from "../../../../../tests/integration/helpers/harness";

describe("sync when a room ends", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a new room on the same host: the phone reads the initial, and mutate works with no second registerSlice", async () => {
    const bus = makeBus();
    const { app: host } = makeStage(bus);
    await host.start();
    host.stage.createRoom();
    host.sync.registerSlice("scores", { ann: 0 });
    host.stage.mutate("scores", scores => ({ ...scores, ann: 5 }));
    host.stage.broadcast();

    await host.session.leave();
    const { code } = host.stage.createRoom();
    const { app: phone } = makeController(bus, "phoneInNewRoom");
    await phone.start();
    await phone.controller.joinRoom(code);

    await vi.waitFor(() => expect(phone.controller.read("scores")).toEqual({ ann: 0 }));

    host.stage.mutate("scores", scores => ({ ...scores, ann: 1 }));
    host.stage.broadcast();
    await vi.waitFor(() => expect(phone.controller.read("scores")).toEqual({ ann: 1 }));

    await phone.stop();
    await host.stop();
  });

  it("a phone's next room: the replica is empty after leave, room:sync-ready fires again, and a first delta applies", async () => {
    const bus = makeBus();
    const { app: first } = makeStage(bus, "firstHost");
    await first.start();
    const firstRoom = first.stage.createRoom();
    first.sync.registerSlice("scores", { ann: 0 });
    first.stage.mutate("scores", scores => ({ ...scores, ann: 5 }));
    first.stage.broadcast();

    const { app: phone, captured } = makeController(bus, "phoneBetweenRooms");
    await phone.start();
    await phone.controller.joinRoom(firstRoom.code);
    await vi.waitFor(() => expect(phone.controller.read("scores")).toEqual({ ann: 5 }));
    expect(countEvent(captured, "room:sync-ready")).toBe(1);

    await phone.session.leave();
    expect(phone.controller.read("scores")).toBeUndefined();

    // This host has no slice when the phone joins, so its first frame is a delta at sSeq 1: at or below the sSeq
    // the phone stopped at in the last room.
    const { app: second } = makeStage(bus, "secondHost");
    await second.start();
    const secondRoom = second.stage.createRoom();
    await phone.controller.joinRoom(secondRoom.code);
    second.sync.registerSlice("round", { n: 1 });
    second.stage.mutate("round", round => ({ ...round, n: 2 }));
    second.stage.broadcast();

    await vi.waitFor(() => expect(phone.controller.read("round")).toEqual({ n: 2 }));
    expect(phone.controller.read("scores")).toBeUndefined();
    expect(countEvent(captured, "room:sync-ready")).toBe(2);

    await phone.stop();
    await second.stop();
    await first.stop();
  });

  it("a reloaded host that leaves before it claims a slice: the saved cells are gone, and registerSlice takes the real initial", async () => {
    stubLocalStorage();
    const bus = makeBus();
    const { app: first } = makeStage(bus);
    await first.start();
    first.stage.createRoom();
    first.sync.registerSlice("scores", { ann: 0 });
    first.stage.mutate("scores", scores => ({ ...scores, ann: 7 }));
    first.stage.broadcast();
    await first.stop();

    const { app: reloaded } = makeStage(bus);
    await reloaded.start();
    expect(reloaded.sync.read("scores")).toEqual({ ann: 7 });

    await reloaded.session.leave();
    reloaded.stage.createRoom();

    expect(reloaded.sync.read("scores")).toBeUndefined();
    reloaded.sync.registerSlice("scores", { ann: 0 });
    expect(reloaded.sync.read("scores")).toEqual({ ann: 0 });

    await reloaded.stop();
  });
});
