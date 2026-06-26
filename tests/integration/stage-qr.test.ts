/**
 * @file Framework-level integration coverage for the public async QR accessor (`stage.qr()` /
 * `session.qr()`), composed through `@moku-labs/web`'s `createApp` over the public `[stagePlugin]`
 * array exactly as a TV/host consumer would. This is the regression guard for the "show QR on the TV →
 * phone scans to join" flow: the rest of the integration suite runs with `generateQr: false`, so this is
 * the only place the real `qrcode` encoder runs end-to-end through the published surface.
 *
 * `createRoom()` is synchronous (contracts §6.2) but QR generation is async (the `qrcode` encoder is
 * lazy-imported host-only), so `RoomDescriptor.qr` is always `null` — the rendered matrix comes from the
 * async `qr()` accessor. The encoder is pure/DOM-free, so it runs under the in-memory signaling bus.
 */

import { describe, expect, it } from "vitest";
import { makeBus, makeStage } from "./helpers/harness";

describe("public QR accessor — stage.qr() / session.qr() (createApp + inMemory)", () => {
  it("stage.qr() resolves a QrMatrix for the open room when generateQr is true", async () => {
    const { app } = makeStage(makeBus(), "qrOnProbe", true);
    await app.start();

    const descriptor = app.stage.createRoom();
    expect(descriptor.qr).toBeNull(); // sync descriptor never carries the async matrix

    const matrix = await app.stage.qr();

    expect(matrix).not.toBeNull();
    if (matrix) {
      expect(matrix.size).toBeGreaterThan(0);
      expect(matrix.modules).toHaveLength(matrix.size * matrix.size);
      expect(matrix.modules.every(m => typeof m === "boolean")).toBe(true);
    }

    await app.stop();
  });

  it("session.qr() (the engine under the facade) resolves the same matrix shape", async () => {
    const { app } = makeStage(makeBus(), "qrEngineProbe", true);
    await app.start();
    app.stage.createRoom();

    const matrix = await app.session.qr();

    expect(matrix).not.toBeNull();
    if (matrix) expect(matrix.modules).toHaveLength(matrix.size * matrix.size);

    await app.stop();
  });

  it("stage.qr() resolves null when generateQr is off (the default test/headless path)", async () => {
    const { app } = makeStage(makeBus()); // generateQr defaults to false
    await app.start();
    app.stage.createRoom();

    await expect(app.stage.qr()).resolves.toBeNull();

    await app.stop();
  });

  it("stage.qr() resolves null before a room is opened, even with generateQr on", async () => {
    const { app } = makeStage(makeBus(), "qrNoRoomProbe", true);
    await app.start();

    await expect(app.stage.qr()).resolves.toBeNull();

    await app.stop();
  });
});
