/**
 * @file Core composition scenarios — framework boot, public-array composition, and lifecycle.
 *
 * Exercises the pre-bundled `[stagePlugin]` / `[controllerPlugin]` arrays through
 * `@moku-labs/web`'s `createApp` over the deterministic `inMemory()` bus. These are the "does the
 * pack compose and boot at all" guarantees a consumer relies on, kept separate from the cross-plugin
 * and user-journey suites.
 */

import { describe, expect, it } from "vitest";
import { makeBus, makeController, makeStage } from "./helpers/harness";

describe("core composition — boot + lifecycle (roomPlugins via createApp + inMemory)", () => {
  it("a stage app composes from [stagePlugin], starts, and stops cleanly", async () => {
    const { app } = makeStage(makeBus());

    await expect(app.start()).resolves.toBeUndefined();
    await expect(app.stop()).resolves.toBeUndefined();
  });

  it("a controller app composes from [controllerPlugin], starts, and stops cleanly", async () => {
    const { app } = makeController(makeBus(), "ctrlBoot");

    await expect(app.start()).resolves.toBeUndefined();
    await expect(app.stop()).resolves.toBeUndefined();
  });

  it("stage.createRoom() returns a RoomDescriptor with a 6-char code, join URL, and host token", async () => {
    const { app } = makeStage(makeBus());
    await app.start();

    const desc = app.stage.createRoom();

    expect(desc.code).toHaveLength(6);
    expect(desc.joinUrl).toContain("?room=");
    expect(desc.hostToken).toMatch(/^[\da-f-]{36}$/i);
    expect(desc.qr).toBeNull(); // generateQr: false on the test bus

    await app.stop();
  });

  it("a controller joins the stage's room over one shared bus (roster grows from 0 to 1)", async () => {
    const bus = makeBus();
    const { app: stageApp } = makeStage(bus);
    const { app: ctrlApp } = makeController(bus, "ctrlJoin");

    await stageApp.start();
    await ctrlApp.start();

    const { code } = stageApp.stage.createRoom();
    expect(stageApp.session.roster()).toHaveLength(0);

    await expect(ctrlApp.controller.joinRoom(code)).resolves.toBeUndefined();

    const { vi } = await import("vitest");
    await vi.waitFor(() => expect(stageApp.session.roster()).toHaveLength(1), { timeout: 5000 });

    await ctrlApp.stop();
    await stageApp.stop();
  });

  it("the stage facade owns no teardown — stopping twice resolves without throwing", async () => {
    const { app } = makeStage(makeBus());
    await app.start();
    app.stage.createRoom();

    await expect(app.stop()).resolves.toBeUndefined();
    await expect(app.stop()).resolves.toBeUndefined();
  });
});
