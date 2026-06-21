/**
 * @file Sandbox STAGE entry (the TV / shared screen). Composes the public `roomPlugins.stage` app, opens a
 * room, renders the join code + QR, and runs the demo "Tap Party" game: every controller→host `tap` intent
 * bumps that peer's cell in the authoritative `scores` slice, which is broadcast to all phones and rendered
 * as a live leaderboard. This is the reference host composition AND the Playwright e2e target — it drives
 * gameplay purely through the public facade (`app.stage`) + the `sync`/`intent` engine registration APIs.
 * @see ./shared.ts
 * @see ./controller.ts
 */
import type { RoomDescriptor } from "../../src/index";
import { makeStageApp, SCORES, TAP } from "./shared";

/**
 * Resolves a required element by id, throwing a clear error if the page markup drifts from this script.
 *
 * @param id - The element id to resolve.
 * @returns The matching `HTMLElement`.
 */
function byId(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`sandbox/stage: missing #${id} in stage.html`);
  return node;
}

/**
 * Writes a status line into the page (and mirrors it to the console) so a human and the e2e suite can both
 * observe the host's lifecycle.
 *
 * @param text - The status message to surface.
 */
function setStatus(text: string): void {
  byId("status").textContent = text;
  console.info(`[stage] ${text}`);
}

/**
 * Paints a {@link import("../../src/index").QrMatrix} onto the canvas — `size × size` dark/light modules
 * scaled up to a comfortable scan target. No-op when QR generation was disabled (`null`).
 *
 * @param qr - The boolean module matrix from the async `app.stage.qr()` accessor, or `null` when
 *   `generateQr` is off.
 */
function renderQr(
  qr: { readonly size: number; readonly modules: readonly boolean[] } | null
): void {
  const canvas = byId("qr") as HTMLCanvasElement;
  if (!qr) return;

  const scale = 6;
  const quiet = 4 * scale;
  const dimension = qr.size * scale + quiet * 2;
  canvas.width = dimension;
  canvas.height = dimension;

  const context = canvas.getContext("2d");
  if (!context) return;

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, dimension, dimension);
  context.fillStyle = "#000000";
  for (let row = 0; row < qr.size; row++) {
    for (let col = 0; col < qr.size; col++) {
      if (qr.modules[row * qr.size + col]) {
        context.fillRect(quiet + col * scale, quiet + row * scale, scale, scale);
      }
    }
  }
}

const app = makeStageApp();

/**
 * Renders the connected-player count and the per-peer tap leaderboard from the live roster + the
 * authoritative `scores` slice. Called on every sync change and on a slow poll (which also catches
 * roster join/leave, since those do not flow through the `scores` subscription).
 */
function renderLeaderboard(): void {
  const roster = app.stage.roster();
  const scores = app.sync.read(SCORES) ?? {};

  byId("player-count").textContent = String(roster.length);

  const rows = roster
    .map(entry => {
      const taps = (scores[entry.id] as number) ?? 0;
      return { label: entry.name ?? entry.id, taps };
    })
    .toSorted((a, b) => b.taps - a.taps)
    .map(r => `<li><span class="who">${r.label}</span><span class="taps">${r.taps}</span></li>`)
    .join("");

  byId("leaderboard").innerHTML =
    rows || `<li class="empty">No players yet — scan the QR to join.</li>`;
}

/**
 * Boots the host: starts the app, registers the demo slice + intent, opens the room, renders the join
 * affordance, and wires the live leaderboard. Surfaces any boot failure into the status line.
 */
async function boot(): Promise<void> {
  setStatus("starting host…");
  try {
    await app.start();

    // Authoritative game state + the single controller intent, registered before the room opens so the
    // first join baseline already carries the (empty) scoreboard.
    app.sync.registerSlice(SCORES, {});
    app.intent.register(TAP, { fields: {}, additionalFields: true });
    app.stage.onIntent(TAP, (_payload, peerId) => {
      app.stage.mutate(SCORES, prev => ({
        ...prev,
        [peerId]: ((prev[peerId] as number) ?? 0) + 1
      }));
      app.stage.broadcast();
    });

    // Reclaim-aware (server signaling, D25): `app.start()` runs the host-reload detector first. When a
    // prior tab persisted a host re-entry record, it has ALREADY restored `role:"host"` + the room code and
    // is re-attaching to the warm DO with the saved reclaim token — so adopt THAT room instead of minting a
    // fresh one (`createRoom()` throws "a room is already active" once a reload was detected). On a normal
    // first boot the role is still "none" and we open a new room synchronously.
    const restored = app.session.self();
    const reclaiming = restored.role === "host" && restored.roomCode !== "";

    let code: string;
    let joinUrl: string;
    let descriptor: RoomDescriptor | undefined;
    if (reclaiming) {
      code = restored.roomCode;
      joinUrl = `${globalThis.location.origin}?room=${code}`;
    } else {
      descriptor = app.stage.createRoom();
      code = descriptor.code;
      joinUrl = descriptor.joinUrl;
    }

    byId("code").textContent = code;
    const link = byId("join-url") as HTMLAnchorElement;
    link.textContent = joinUrl;
    link.href = joinUrl;

    // Render the join QR via the public async accessor. `createRoom()` is synchronous (so `descriptor.qr`
    // is always null), but QR generation is async — the `qrcode` encoder is lazy-imported host-only. The
    // accessor reads the (restored or fresh) room code, so a reclaimed room re-paints its QR too.
    const qr = await app.stage.qr();
    renderQr(qr);
    byId("qr-hint").textContent = qr ? "Scan to join" : "Enter the code on your phone to join";

    // Live leaderboard: re-render on every authoritative change, plus a slow poll for roster join/leave.
    app.sync.subscribe(SCORES, () => renderLeaderboard());
    setInterval(renderLeaderboard, 750);
    renderLeaderboard();

    globalThis.roomStage = { code, joinUrl, ...(descriptor ? { descriptor } : {}) };
    setStatus(
      reclaiming
        ? `room ${code} reclaimed — recovering players`
        : `room ${code} open — waiting for players`
    );
  } catch (error) {
    setStatus(`host failed to start: ${(error as Error).message}`);
    console.error(error);
  }
}

await boot();
