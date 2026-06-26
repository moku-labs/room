/**
 * @file Sandbox CONTROLLER entry (the phone). Composes the public `[controllerPlugin]` app, joins a
 * room by code (auto-filled from the scanned `?room=` URL or typed in), then plays the demo "Tap Party":
 * the big button fires a `tap` intent at the host on every press, and the controller renders its own live
 * score from the read-only synced `scores` replica. Reference phone composition AND Playwright e2e target;
 * drives everything through the public facade (`app.controller`) exactly as a real game plugin would.
 * @see ./shared.ts
 * @see ./stage.ts
 */
import { makeControllerApp, ROOM_PARAM, SCORES, TAP } from "./shared";

/**
 * Resolves a required element by id, throwing a clear error if the page markup drifts from this script.
 *
 * @param id - The element id to resolve.
 * @returns The matching `HTMLElement`.
 */
function byId(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`sandbox/controller: missing #${id} in controller.html`);
  return node;
}

/**
 * Writes a status line into the page (and mirrors it to the console) so a human and the e2e suite can both
 * observe the controller's lifecycle.
 *
 * @param text - The status message to surface.
 */
function setStatus(text: string): void {
  byId("status").textContent = text;
  console.info(`[controller] ${text}`);
}

const app = makeControllerApp();

/**
 * Renders this controller's own tap count (and the full per-peer board) from the read-only `scores`
 * replica. The board is keyed by `peerId`; this device's id is marked so the player can spot their row.
 */
function renderScores(): void {
  const selfId = app.session.self().selfId;
  const scores = app.controller.read(SCORES) ?? {};

  byId("my-score").textContent = String((scores[selfId] as number) ?? 0);

  const rows = Object.entries(scores)
    .map(([id, taps]) => ({ id, taps: (taps as number) ?? 0 }))
    .toSorted((a, b) => b.taps - a.taps)
    .map(
      r =>
        `<li class="${r.id === selfId ? "me" : ""}"><span class="who">${r.id === selfId ? "you" : r.id}</span><span class="taps">${r.taps}</span></li>`
    )
    .join("");

  byId("board").innerHTML = rows || `<li class="empty">No taps yet.</li>`;
}

/**
 * Joins the room identified by `code`: flips the UI into the game view on success, requests a Screen Wake
 * Lock (iOS keeps the DataChannel alive), and subscribes to the synced scoreboard. On failure the thrown
 * reason ("full" | "not-found" | "unreachable") is surfaced into the status line.
 *
 * @param code - The 6-char room code to join.
 */
async function join(code: string): Promise<void> {
  const trimmed = code.trim().toUpperCase();
  if (!trimmed) {
    setStatus("enter a room code first");
    return;
  }

  setStatus(`joining ${trimmed}…`);
  (byId("join-btn") as HTMLButtonElement).disabled = true;
  try {
    await app.controller.joinRoom(trimmed);
    await app.controller.requestWakeLock();

    byId("lobby").hidden = true;
    byId("game").hidden = false;
    app.controller.on(SCORES, () => renderScores());
    renderScores();

    globalThis.roomController = { code: trimmed, joined: true };
    setStatus(`connected to ${trimmed}`);
  } catch (error) {
    (byId("join-btn") as HTMLButtonElement).disabled = false;
    globalThis.roomController = { code: trimmed, joined: false };
    setStatus(`could not join: ${(error as Error).message}`);
    console.error(error);
  }
}

/**
 * Boots the controller: starts the app, wires the lobby + tap controls, and auto-joins when the page was
 * opened from a scanned join URL (`?room=CODE`).
 */
async function boot(): Promise<void> {
  setStatus("starting controller…");
  try {
    await app.start();

    const fromUrl = new URLSearchParams(globalThis.location.search).get(ROOM_PARAM) ?? "";
    const input = byId("code-input") as HTMLInputElement;
    input.value = fromUrl;
    globalThis.roomController = { code: fromUrl, joined: false };

    byId("join-btn").addEventListener("click", () => void join(input.value));
    byId("tap-btn").addEventListener("click", () => app.controller.intent(TAP, {}));

    if (fromUrl) {
      await join(fromUrl);
    } else {
      setStatus("enter the room code shown on the TV");
    }
  } catch (error) {
    setStatus(`controller failed to start: ${(error as Error).message}`);
    console.error(error);
  }
}

await boot();
