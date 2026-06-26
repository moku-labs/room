/**
 * @file Worker-backed e2e — the FIRST real-`workerd` coverage of the Hub Durable Object. W1–W3
 * unit-tested the DO dispatch (`webSocketMessage` join/reclaim/relay, star topology, guards) through a
 * lightweight Hibernation/SQLite fake; this drives the SAME protocol for real: the sandbox runs in
 * `?signaling=server` mode against `wrangler dev` (the dev-only `tests/sandbox/wrangler.jsonc`), so the
 * worker serves the built web client through `env.ASSETS` AND brokers signaling over the per-room DO.
 *
 * It is gated to its own config (`playwright.worker.config.ts`, port 5180) so the default CI run stays
 * workerd-free; run it with `bun run test:e2e:worker`. Asserts the three reachable real-runtime behaviours
 * from `.planning/specs/07-hub.md` §Sandbox:
 *   1. `101` (WS upgrade → DO) vs `200` (plain GET → ASSETS) routing through `app.hub.handle`.
 *   2. a two-controller star handshake over the DO → real P2P RTCDataChannel handoff (host↔controller).
 *   3. host-reload RECLAIM recovery against the warm DO.
 *
 * NOTE — the `{kind:"evict"} → room-evicted` path is intentionally NOT covered here: the DO only emits
 * `evict` from its idle Alarm when ZERO sockets remain (it iterates an empty socket set — a defensive GC
 * notify, unreachable by a live client), so there is no client to receive it over real workerd. That
 * adapter→event mapping is covered where it IS reachable: the `serverSignaling`/`inMemory({server:true})`
 * unit + integration suites (`transport/__tests__/.../server-signaling-adapter`, `persistent-session`).
 *
 * Real WebRTC is networked-on-loopback and therefore inherently a little flaky; tests run serial with
 * generous timeouts.
 */
import { expect, test } from "@playwright/test";

/** Reads + validates the 6-char room code the stage minted (server mode still uses the demo default). */
async function readRoomCode(stagePage: import("@playwright/test").Page): Promise<string> {
  await expect(stagePage.getByTestId("room-code")).toHaveText(/^[A-Z0-9]{6,8}$/, {
    timeout: 30_000
  });
  const raw = await stagePage.getByTestId("room-code").textContent();
  const text = raw?.trim() ?? "";
  expect(text).toMatch(/^[A-Z0-9]{6,8}$/);
  return text;
}

test.describe("hub worker (real workerd, ?signaling=server)", () => {
  test.describe.configure({ mode: "serial" });

  test("routes WS upgrades to the DO (101) and plain GETs to ASSETS (200)", async ({ page }) => {
    // Plain GET → the worker delegates to env.ASSETS → the built client HTML (200).
    const res = await page.request.get("/");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"] ?? "").toContain("text/html");
    expect(await res.text()).toContain('data-testid="go-stage"');

    // WS upgrade → the worker forwards to the per-room DO, which Hibernation-accepts (101). A browser
    // WebSocket only fires `open` after a successful 101 handshake, so an opened socket proves the route.
    await page.goto("/");
    const opened = await page.evaluate(
      () =>
        new Promise<boolean>(resolve => {
          const ws = new WebSocket(`ws://${location.host}/PROBE101`);
          const timer = setTimeout(() => {
            ws.close();
            resolve(false);
          }, 15_000);
          ws.addEventListener("open", () => {
            clearTimeout(timer);
            ws.close();
            resolve(true);
          });
          ws.addEventListener("error", () => {
            clearTimeout(timer);
            resolve(false);
          });
        })
    );
    expect(opened, "WS upgrade to /<code> should 101 from the DO").toBe(true);
  });

  test("two controllers complete the star handshake over the DO and their taps reach the host", async ({
    browser
  }) => {
    test.setTimeout(120_000);
    const stageCtx = await browser.newContext();
    const phoneACtx = await browser.newContext();
    const phoneBCtx = await browser.newContext();
    const stage = await stageCtx.newPage();
    const phoneA = await phoneACtx.newPage();
    const phoneB = await phoneBCtx.newPage();

    try {
      // Host opens a room over the worker hub.
      await stage.goto("/stage?signaling=server");
      await expect(stage.getByTestId("status")).toContainText("open", { timeout: 30_000 });
      const code = await readRoomCode(stage);

      // Both phones join over the DO and complete a real RTCDataChannel handshake with the host.
      await phoneA.goto(`/controller?signaling=server&room=${code}`);
      await expect(phoneA.getByTestId("status")).toContainText("connected", { timeout: 60_000 });
      await expect(phoneA.getByTestId("game")).toBeVisible();

      await phoneB.goto(`/controller?signaling=server&room=${code}`);
      await expect(phoneB.getByTestId("status")).toContainText("connected", { timeout: 60_000 });
      await expect(phoneB.getByTestId("game")).toBeVisible();

      // The host admits BOTH controllers (the star hub holds two edges; controllers never mesh).
      await expect(stage.getByTestId("player-count")).toHaveText("2", { timeout: 60_000 });

      // Taps from each phone fire `tap` intents over their own DataChannel → the host applies + broadcasts
      // → both replicas converge above zero (proving host↔A and host↔B channels both carry gameplay).
      await phoneA.getByTestId("tap-btn").click();
      await phoneA.getByTestId("tap-btn").click();
      await phoneA.getByTestId("tap-btn").click();
      await phoneB.getByTestId("tap-btn").click();
      await phoneB.getByTestId("tap-btn").click();

      await expect(phoneA.getByTestId("my-score")).not.toHaveText("0", { timeout: 30_000 });
      await expect(phoneB.getByTestId("my-score")).not.toHaveText("0", { timeout: 30_000 });
      // The host leaderboard shows two non-empty rows (both controllers scored through the star hub).
      await expect(stage.getByTestId("leaderboard")).toContainText(/[1-9]/, { timeout: 30_000 });
    } finally {
      await stageCtx.close();
      await phoneACtx.close();
      await phoneBCtx.close();
    }
  });

  test("host reload reclaims the warm DO and the controller recovers", async ({ browser }) => {
    test.setTimeout(120_000);
    const stageCtx = await browser.newContext();
    const phoneCtx = await browser.newContext();
    const stage = await stageCtx.newPage();
    const phone = await phoneCtx.newPage();

    try {
      // Host + one controller, connected over the worker hub.
      await stage.goto("/stage?signaling=server");
      await expect(stage.getByTestId("status")).toContainText("open", { timeout: 30_000 });
      const code = await readRoomCode(stage);

      await phone.goto(`/controller?signaling=server&room=${code}`);
      await expect(phone.getByTestId("status")).toContainText("connected", { timeout: 60_000 });
      await expect(stage.getByTestId("player-count")).toHaveText("1", { timeout: 60_000 });

      // A tap drives an authoritative snapshot → `sync` calls `session.persistSnapshot`, which captures the
      // DO reclaim token. The synchronous localStorage write fires on the reload's visibilitychange:hidden,
      // so the re-entry record (incl. the token) survives the reload.
      await phone.getByTestId("tap-btn").click();
      await expect(stage.getByTestId("leaderboard")).toContainText(/[1-9]/, { timeout: 30_000 });

      // Reload the host tab — `detectHostReload` reads the persisted record and re-attaches to the SAME
      // room code with the saved reclaim token (the warm DO re-binds the host, not a fresh empty room).
      await stage.reload();
      await expect(stage.getByTestId("status")).toContainText("reclaimed", { timeout: 30_000 });
      const reclaimedCode = await stage.evaluate(() => globalThis.roomStage?.code ?? "");
      expect(reclaimedCode, "the reloaded host re-adopts the same room code").toBe(code);

      // The surviving controller is re-announced by the warm DO and re-handshakes a fresh DataChannel — the
      // host roster returns to 1 and a post-reload tap lands on the (recovered) scoreboard.
      await expect(stage.getByTestId("player-count")).toHaveText("1", { timeout: 60_000 });
      await phone.getByTestId("tap-btn").click();
      await expect(stage.getByTestId("leaderboard")).toContainText(/[2-9]/, { timeout: 30_000 });
    } finally {
      await stageCtx.close();
      await phoneCtx.close();
    }
  });
});
