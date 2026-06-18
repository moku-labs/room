/**
 * @file Deterministic, offline e2e smoke for the sandbox demo. Uses the in-process `?signaling=memory`
 * bus so NO network / Trystero relay is touched: each test verifies that the bundled stage / controller
 * page composes the public `roomPlugins.*` arrays through `@moku-labs/web`'s `createApp` and BOOTS in a
 * real browser. This is the regression guard that the published surface still wires up + runs client-side;
 * the real cross-device WebRTC gate is `real-webrtc-interop.spec.ts` (opt-in) and the manual hardware run
 * documented in `sandbox/README.md`.
 */
import { expect, test } from "@playwright/test";

test.describe("sandbox smoke (offline, in-memory signaling)", () => {
  test("role picker links to both roles", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("go-stage")).toHaveAttribute("href", "/stage");
    await expect(page.getByTestId("go-controller")).toHaveAttribute("href", "/controller");
  });

  test("stage boots and opens a room (code + join URL)", async ({ page }) => {
    const crashes: string[] = [];
    page.on("pageerror", error => crashes.push(error.message));

    await page.goto("/stage?signaling=memory");

    // createRoom() is synchronous, so the room opens without any peer/relay.
    await expect(page.getByTestId("status")).toContainText("open", { timeout: 20_000 });
    await expect(page.getByTestId("room-code")).toHaveText(/^[A-Z0-9]{6}$/);
    await expect(page.getByTestId("join-url")).toHaveAttribute("href", /room=[A-Z0-9]{6}/);

    // The room code is mirrored onto the window handle for debugging / the live interop spec.
    const handleCode = await page.evaluate(() => globalThis.roomStage?.code ?? "");
    expect(handleCode).toMatch(/^[A-Z0-9]{6}$/);

    expect(crashes, `uncaught page errors: ${crashes.join(" | ")}`).toEqual([]);
  });

  // The stage paints a join QR through the PUBLIC surface: `createRoom()` is synchronous (so
  // `RoomDescriptor.qr` is null), and the host renders the matrix from the async `app.stage.qr()`
  // accessor (see .planning/build/findings.md "Step 5.9.x"). boot() awaits `stage.qr()` and paints the
  // canvas BEFORE flipping the status to "open", so by the time "open" is visible the canvas has a
  // non-zero width.
  test("stage renders a join QR", async ({ page }) => {
    await page.goto("/stage?signaling=memory");
    await expect(page.getByTestId("status")).toContainText("open", { timeout: 20_000 });

    const qrWidth = await page
      .getByTestId("qr")
      .evaluate(node => (node as HTMLCanvasElement).width);
    expect(qrWidth).toBeGreaterThan(0);
  });

  test("controller boots into the lobby awaiting a code", async ({ page }) => {
    const crashes: string[] = [];
    page.on("pageerror", error => crashes.push(error.message));

    await page.goto("/controller?signaling=memory");

    await expect(page.getByTestId("status")).toContainText("enter the room code", {
      timeout: 20_000
    });
    await expect(page.getByTestId("lobby")).toBeVisible();
    await expect(page.getByTestId("game")).toBeHidden();
    await expect(page.getByTestId("join-btn")).toBeEnabled();

    expect(crashes, `uncaught page errors: ${crashes.join(" | ")}`).toEqual([]);
  });
});
