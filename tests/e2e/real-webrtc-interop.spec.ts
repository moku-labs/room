/**
 * @file Live, networked e2e: the automated approximation of the v1 WebRTC gate. Drives the sandbox over
 * the REAL `publicRendezvous` (Trystero / Nostr) backbone in two isolated browser contexts (one stage, one
 * controller) and asserts the full join → tap-intent → synced-replica loop across a genuine
 * RTCDataChannel. Networked and therefore flaky, so it is GATED behind `ROOM_E2E_LIVE=1`.
 *
 * This does NOT replace the manual iPhone-Safari ↔ Sony Bravia-7 interop run (two real devices, two
 * engines, mDNS LAN path) documented in `sandbox/README.md` — that hardware spike is the actual gate.
 */
import { expect, test } from "@playwright/test";

const LIVE = !!process.env.ROOM_E2E_LIVE;
const PORT = Number(process.env.PORT ?? 5179);
const BASE = `http://localhost:${PORT}`;

test.describe("real-webrtc interop (live, publicRendezvous)", () => {
  test.skip(!LIVE, "networked spike — set ROOM_E2E_LIVE=1 to run");
  test.describe.configure({ mode: "serial", timeout: 90_000 });

  test("a controller joins over real WebRTC and its taps reach the host scoreboard", async ({
    browser
  }) => {
    const stageCtx = await browser.newContext({ baseURL: BASE });
    const phoneCtx = await browser.newContext({ baseURL: BASE });
    const stage = await stageCtx.newPage();
    const phone = await phoneCtx.newPage();

    try {
      // Host opens a room and surfaces a 6-char code.
      await stage.goto("/stage");
      await expect(stage.getByTestId("room-code")).toHaveText(/^[A-Z0-9]{6}$/, { timeout: 30_000 });
      const codeText = await stage.getByTestId("room-code").textContent();
      const code = codeText?.trim() ?? "";
      expect(code).toMatch(/^[A-Z0-9]{6}$/);

      // Phone opens the scanned join URL and auto-joins over the real backbone.
      await phone.goto(`/controller?room=${code}`);
      await expect(phone.getByTestId("status")).toContainText("connected", { timeout: 60_000 });
      await expect(phone.getByTestId("game")).toBeVisible();

      // The host admits the controller (roster grows to 1).
      await expect(stage.getByTestId("player-count")).toHaveText("1", { timeout: 60_000 });

      // Taps fire `tap` intents; the host applies + broadcasts; both replicas converge above zero.
      await phone.getByTestId("tap-btn").click();
      await phone.getByTestId("tap-btn").click();
      await phone.getByTestId("tap-btn").click();

      await expect(phone.getByTestId("my-score")).not.toHaveText("0", { timeout: 30_000 });
      await expect(stage.getByTestId("leaderboard")).toContainText(/[1-9]/, { timeout: 30_000 });
    } finally {
      await stageCtx.close();
      await phoneCtx.close();
    }
  });
});
