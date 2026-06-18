import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for the `@moku-labs/room` sandbox e2e suite. Drives the runnable demo in
 * `tests/sandbox` through a real browser. The `webServer` block boots `tests/sandbox/serve.ts`
 * (Bun.build + Bun.serve) and waits for it before the specs run.
 *
 * Two spec tiers live under `tests/e2e`:
 * - `*-smoke.spec.ts` — deterministic, offline (uses the `?signaling=memory` bus); runs in CI with just
 *   Chromium.
 * - `*-interop.spec.ts` — real-WebRTC over `publicRendezvous`; networked + flaky, gated behind
 *   `ROOM_E2E_LIVE=1`. The true cross-device gate (iPhone-Safari ↔ Bravia-7) is manual — see
 *   `tests/sandbox/README.md`.
 */
const PORT = Number(process.env.PORT ?? 5179);

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "on-first-retry"
  },
  projects: [
    {
      name: "chromium",
      // Set PW_CHANNEL=chrome (or msedge) to drive a system browser instead of Playwright's bundled
      // Chromium — handy when the managed binaries are not installed.
      use: {
        ...devices["Desktop Chrome"],
        ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {})
      }
    }
  ],
  webServer: {
    command: "bun tests/sandbox/serve.ts",
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000
  }
});
