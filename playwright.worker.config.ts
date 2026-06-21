import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for the WORKER-backed e2e tier — the first real-`workerd` coverage of the RoomHub
 * Durable Object (W1–W3 unit-tested the DO dispatch through a Hibernation/SQLite fake; this drives it for
 * real). It is deliberately SEPARATE from `playwright.config.ts` so the default CI run stays workerd-free:
 * only `tests/e2e/room-hub-worker.spec.ts` runs here, against `wrangler dev`.
 *
 * The `webServer` block runs `bun run sandbox:worker` — builds the sandbox client (`build-client.ts`), then
 * boots `wrangler dev` on the dev-only `tests/sandbox/wrangler.jsonc` (port 5180). That worker serves the
 * built web client through the `ASSETS` binding AND hosts the per-room DO, so the `?signaling=server`
 * sandbox composes web + worker end-to-end over one origin.
 *
 * Run it with `bun run test:e2e:worker`. It needs `wrangler` (a dev dep) + workerd (auto-fetched on first
 * `wrangler dev`), so it is not part of the default `bun run test:e2e`.
 */
const WORKER_PORT = Number(process.env.WORKER_PORT ?? 5180);

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/room-hub-worker.spec.ts",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  // Real WebRTC + a cold `wrangler dev`/`workerd` boot — give each test ample headroom.
  timeout: 90_000,
  use: {
    baseURL: `http://localhost:${WORKER_PORT}`,
    trace: "on-first-retry"
  },
  projects: [
    {
      name: "chromium-worker",
      // PW_CHANNEL=chrome (or msedge) drives a system browser instead of the bundled Chromium.
      use: {
        ...devices["Desktop Chrome"],
        ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}),
        // Real WebRTC between two browser contexts on ONE machine (loopback): Chromium otherwise hides
        // local-IP host candidates behind `.local` mDNS names that the peer context cannot resolve, so ICE
        // never connects. Disabling that obfuscation exposes raw 127.0.0.1/LAN host candidates — a
        // test-harness setting for localhost e2e, not a Room concern (a real LAN deploy uses real IPs).
        launchOptions: { args: ["--disable-features=WebRtcHideLocalIpsWithMdns"] }
      }
    }
  ],
  webServer: {
    command: "bun run sandbox:worker",
    url: `http://localhost:${WORKER_PORT}`,
    reuseExistingServer: !process.env.CI,
    // First `wrangler dev` fetches the workerd binary; allow a generous cold-start window.
    timeout: 180_000,
    // Keep `wrangler dev` non-interactive (no telemetry-consent prompt blocking the boot).
    env: { WRANGLER_SEND_METRICS: "false" }
  }
});
