/**
 * @file Server-tier signaling scenarios (Cycle 2) — the opt-in operated signaling path exercised through
 * the PUBLIC `roomPlugins` arrays exactly as a consumer would opt into it: by swapping the transport
 * `signaling` adapter to the server-mode bus (`inMemory({ server: true })`, the deterministic stand-in for
 * the `serverSignaling` Worker tier). No other composition change is required — that interchangeability is
 * the `Signaling` seam's whole point (D12/D25).
 *
 * Scope note: the server-mode bus brokers signaling only (no in-process loopback `WireChannel`), so these
 * scenarios assert what is observable through the public surface without a real WebRTC channel — adapter
 * selection + boot/stop, the host-reload `reclaimToken` conduit (`app.transport.reclaimToken()`), and the
 * server-deployment `codeLength` widening (D24). Full channel-carrying behaviour lives in the colocated
 * transport/session/room-hub suites and the manual real-`workerd` Playwright run.
 */

import { createApp, createPlugin } from "@moku-labs/web";
import { describe, expect, it } from "vitest";
import { inMemory, roomPlugins, stagePlugin } from "../../src/index";
import { makeServerBus, makeStage } from "./helpers/harness";

describe("server-tier signaling — opt-in via the public roomPlugins arrays (inMemory server mode)", () => {
  it("a stage app composes from roomPlugins.stage over the server-mode bus, starts, and stops cleanly", async () => {
    const { app } = makeStage(makeServerBus());

    await expect(app.start()).resolves.toBeUndefined();
    app.stage.createRoom();
    await expect(app.stop()).resolves.toBeUndefined();
  });

  it("createRoom() over the server tier surfaces a host reclaim token via app.transport.reclaimToken()", async () => {
    const { app } = makeStage(makeServerBus());
    await app.start();

    // No room yet → no session → no token.
    expect(app.transport.reclaimToken()).toBeNull();

    // createRoom() fires transport.connect({ role: "host" }) async; the server-mode session mints a
    // reclaim token (mirrors the DO's join-ack) that transport exposes for session to persist (D25).
    app.stage.createRoom();

    const { vi } = await import("vitest");
    await vi.waitFor(() => expect(app.transport.reclaimToken()).not.toBeNull(), { timeout: 5000 });
    expect(app.transport.reclaimToken()).toMatch(/^[\da-f-]{36}$/i); // crypto.randomUUID() shape

    await app.stop();
  });

  it("session.codeLength: 8 widens the room code for a server deployment (D24)", async () => {
    const probe = createPlugin("codeLenProbe", {
      depends: [stagePlugin],
      createState: (): Record<string, never> => ({}),
      api: (): Record<string, never> => ({}),
      hooks: () => ({})
    });

    const app = createApp({
      plugins: [...roomPlugins.stage, probe],
      pluginConfigs: {
        site: { name: "room-test", url: "https://room.test" },
        transport: { signaling: inMemory({ server: true }) },
        session: { generateQr: false, codeLength: 8 }
      }
    });

    await app.start();

    const { code } = app.stage.createRoom();
    expect(code).toHaveLength(8); // vs the default ROOM_CODE_LENGTH = 6

    await app.stop();
  });
});
