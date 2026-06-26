/**
 * @file Shared sandbox wiring for the runnable `@moku-labs/room` demo — the bits the stage (TV) and the
 * controller (phone) entries have in common: the demo game's slice / intent names, and the two
 * `createApp` config builders that compose the public `roomPlugins.{stage,controller}` arrays over the
 * DEFAULT serverless signaling adapter (`publicRendezvous`, real WebRTC) on `@moku-labs/web/browser`.
 *
 * This is NOT library code — it is the reference consumer composition (the same shape a real couch game
 * would write) and doubles as the Playwright e2e target. It imports the live framework source
 * (`../../src/index`) so the demo always tracks the working tree (Bun bundles it; no build step of the
 * package is required), mirroring the integration harness's `../../../src/index` import note.
 *
 * Inference note: the per-app `pluginConfigs` is built by `roomConfigs()` as a SEPARATELY-typed value
 * (never an inline object literal inside `createApp`). An inline literal would be contextually typed
 * against `createApp`'s `pluginConfigs` mapped type, forcing TS to resolve the plugin union `P` while it
 * is still inferring `ExtraPlugins` from `plugins` — a circularity that collapses `ExtraPlugins` to its
 * `AnyPluginInstance[]` constraint and erases `app.stage` / `app.sync` from the result. The harness uses
 * the same pre-computed-config technique.
 * @see ./stage.ts
 * @see ./controller.ts
 * @see ./README.md
 */

import type { Signaling } from "../../src/index";
import {
  controllerPlugin,
  createApp,
  inMemory,
  publicRendezvous,
  serverSignaling,
  stagePlugin
} from "../../src/index";

/** The single authoritative sync slice the demo game keeps — a per-peer tap scoreboard (`peerId → count`). */
export const SCORES = "scores";

/** The single controller→host intent the demo sends — one tap. Validated correctness-only by `intent`. */
export const TAP = "tap";

/** Default port the sandbox dev server (`serve.ts`) listens on; the Playwright config reuses it. */
export const SANDBOX_PORT = 5179;

/** The query param the join URL embeds the room code in (`?room=CODE`) — read by the controller entry. */
export const ROOM_PARAM = "room";

/**
 * Resolves the same-origin `ws(s)://<host>` base for the worker-backed signaling hub. `serverSignaling`
 * appends `/<code>` to reach the per-room Durable Object, so this is just the page origin re-schemed to the
 * WebSocket protocol — `wrangler dev` serves the client AND the DO from one origin (`bun run sandbox:worker`
 * on :5180), and a real deploy is `wss://` behind TLS.
 *
 * @returns The `ws://`/`wss://` origin of the hub worker.
 * @example
 * ```ts
 * workerWsOrigin(); // on http://localhost:5180 → "ws://localhost:5180"
 * ```
 */
function workerWsOrigin(): string {
  const location = globalThis.location;
  const secure = location?.protocol === "https:";
  const host = location?.host ?? "localhost:5180";
  return `${secure ? "wss:" : "ws:"}//${host}`;
}

/**
 * Selects the signaling backbone from the page URL so the sandbox can run three ways without a rebuild:
 * `?signaling=memory` uses the in-process `inMemory()` bus (single JS context only — handy for a
 * deterministic same-page smoke test); `?signaling=server` uses the worker-backed `serverSignaling` adapter
 * over the same-origin hub DO (the `wrangler dev` worker harness, D21/D25); anything else (the default)
 * uses the real serverless `publicRendezvous` WebRTC path (the two-device v1 GATE). A `?backbone=torrent`
 * switches the BitTorrent fallback for the `publicRendezvous` path.
 *
 * @returns The chosen `Signaling` adapter instance.
 */
export function pickSignaling(): Signaling {
  const params = new URLSearchParams(globalThis.location?.search ?? "");
  const mode = params.get("signaling");

  if (mode === "memory") return inMemory();
  if (mode === "server") return serverSignaling(workerWsOrigin());

  const backbone = params.get("backbone") === "torrent" ? "torrent" : "nostr";
  return publicRendezvous({ backbone });
}

/**
 * Builds the per-app `pluginConfigs` block as a standalone, pre-typed value (see the inference note in the
 * file header): the required `site` metadata, the chosen signaling adapter on `transport`, and whether
 * `session` generates QR matrix data (ON for the TV, OFF for the phone).
 *
 * @param label - Human-readable site name suffix for this role ("Stage" / "Controller").
 * @param generateQr - Whether `session.createRoom()` should also produce QR data.
 * @returns The `pluginConfigs` object to hand to `createApp`.
 */
function roomConfigs(label: string, generateQr: boolean) {
  return {
    site: {
      name: `Room Sandbox — ${label}`,
      url: globalThis.location?.origin ?? "https://room.test"
    },
    transport: { signaling: pickSignaling() },
    session: { generateQr }
  };
}

/**
 * Builds the STAGE (host / shared-screen) app: the public `[stagePlugin]` array composed through
 * `@moku-labs/web`'s `createApp`, with QR generation ON (the TV renders the join QR).
 *
 * @returns The composed host `App` exposing `app.stage`, `app.sync`, `app.intent`, `app.session`.
 */
export function makeStageApp() {
  return createApp({
    plugins: [stagePlugin],
    pluginConfigs: roomConfigs("Stage", true)
  });
}

/**
 * Builds the CONTROLLER (phone) app: the public `[controllerPlugin]` array composed through
 * `createApp`, with QR generation OFF (the phone scans, it does not display).
 *
 * @returns The composed controller `App` exposing `app.controller`, `app.sync`, `app.session`.
 */
export function makeControllerApp() {
  return createApp({
    plugins: [controllerPlugin],
    pluginConfigs: roomConfigs("Controller", false)
  });
}
