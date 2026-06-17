/**
 * @file Join-URL composition + QR-matrix building (§6.2). The QR encodes the join URL ONLY (which embeds
 * the room code) — NEVER SDP/ICE (the cameraless TV cannot scan an answer-back QR; the rendezvous is the
 * answer-back channel). The `qrcode` generator is lazy-`import()`ed HOST-ONLY so it tree-shakes out of the
 * `<5 KB` controller bundle (research MED "controller bundle creep").
 * @see ../README.md
 */

import type { QrMatrix } from "../types";

/**
 * Composes the controller join URL. When `joinUrlBase` is empty, falls back to the current document
 * `location.origin` at runtime (keeping `state.ts` DOM-free). Shape: `${base}?room=CODE` (§6.2).
 *
 * @param code - The room code to embed.
 * @param joinUrlBase - Config origin; empty string means "use `location.origin`".
 * @throws {Error} Always — skeleton stub.
 * @example
 * ```ts
 * const url = buildJoinUrl("G7K2QF", ""); // -> "https://tv.example?room=G7K2QF"
 * ```
 */
export function buildJoinUrl(code: string, joinUrlBase: string): string {
  throw new Error("not implemented");
}

/**
 * Lazy-loads the QR generator (HOST path only) and encodes `joinUrl` into a row-major boolean
 * {@link QrMatrix}. The encoded payload is the URL ONLY — never SDP/ICE (§6.2). Returns `null` when
 * `generateQr` is `false` so the controller/headless path does no QR work.
 *
 * @param joinUrl - The URL to encode (code/URL only).
 * @param generateQr - When `false`, skip QR work and return `null`.
 * @throws {Error} Always — skeleton stub.
 * @example
 * ```ts
 * const qr = await buildQrMatrix(url, true);
 * ```
 */
export async function buildQrMatrix(
  joinUrl: string,
  generateQr: boolean
): Promise<QrMatrix | null> {
  throw new Error("not implemented");
}
