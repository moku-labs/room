/**
 * @file Integration test for a host reload's sync state, on the real stage app: `session` reads the re-entry
 * record from a stubbed `localStorage`, and `sync` imports it during `onInit`. A "load" is a new `createApp`
 * on the same bus and the same storage.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeBus,
  makeStage,
  stubLocalStorage
} from "../../../../../tests/integration/helpers/harness";

/**
 * Plays one round on a host and stops it, as a tab reload does.
 *
 * @param bus - The signaling bus of the room.
 * @returns The `sSeq` the host stopped at.
 */
async function playAndStop(bus: ReturnType<typeof makeBus>): Promise<number> {
  const { app } = makeStage(bus);
  await app.start();
  app.stage.createRoom();
  app.sync.registerSlice("scores", { ann: 0 });
  app.stage.mutate("scores", scores => ({ ...scores, ann: 7 }));
  app.stage.broadcast();
  const { sSeq } = app.sync.exportSnapshot();
  await app.stop();
  return sSeq;
}

describe("sync after a host reload", () => {
  beforeEach(() => {
    stubLocalStorage();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("read gives the saved cells before and after registerSlice with another initial, and sSeq is restored", async () => {
    const bus = makeBus();
    const savedSeq = await playAndStop(bus);
    expect(savedSeq).toBeGreaterThan(0);

    const { app: next } = makeStage(bus);
    await next.start();

    expect(next.sync.read("scores")).toEqual({ ann: 7 });
    expect(next.sync.exportSnapshot().sSeq).toBe(savedSeq);

    // The boot code is the same on every load: it registers the slice with its first-load initial.
    next.sync.registerSlice("scores", { ann: 0 });

    expect(next.sync.read("scores")).toEqual({ ann: 7 });
    expect(next.sync.exportSnapshot().sSeq).toBe(savedSeq);
    await next.stop();
  });

  it("a second registerSlice after the restored one keeps the usual rules", async () => {
    const bus = makeBus();
    await playAndStop(bus);

    const { app: next } = makeStage(bus);
    await next.start();
    next.sync.registerSlice("scores", { ann: 0 });

    expect(() => next.sync.registerSlice("scores", { ann: 0 })).not.toThrow();
    expect(() => next.sync.registerSlice("scores", { ann: 99 })).toThrow(/already registered/);
    await next.stop();
  });
});
