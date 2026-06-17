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
 * @returns The full join URL string in the form `${base}?room=CODE`.
 * @example
 * ```ts
 * const url = buildJoinUrl("G7K2QF", ""); // -> "https://tv.example?room=G7K2QF"
 * ```
 */
export function buildJoinUrl(code: string, joinUrlBase: string): string {
  let base: string;
  if (joinUrlBase !== "") {
    base = joinUrlBase;
  } else if (typeof location === "undefined") {
    base = "";
  } else {
    base = location.origin;
  }
  return `${base}?room=${code}`;
}

/**
 * Lazy-loads the QR generator (HOST path only) and encodes `joinUrl` into a row-major boolean
 * {@link QrMatrix}. The encoded payload is the URL ONLY — never SDP/ICE (§6.2). Returns `null` when
 * `generateQr` is `false` so the controller/headless path does no QR work.
 *
 * @param joinUrl - The URL to encode (code/URL only).
 * @param generateQr - When `false`, skip QR work and return `null`.
 * @returns A promise resolving to a `QrMatrix` or `null` when generation is disabled.
 * @example
 * ```ts
 * const qr = await buildQrMatrix(url, true);
 * ```
 */
export async function buildQrMatrix(
  joinUrl: string,
  generateQr: boolean
): Promise<QrMatrix | null> {
  if (!generateQr) return null;

  // Lazy-import to keep the QR generator out of the controller bundle.
  const qrcode = await import("qrcode");
  const matrix = await qrcode.default.create(joinUrl, { errorCorrectionLevel: "M" });

  const size = matrix.modules.size;
  const modules: boolean[] = [];
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      modules.push(matrix.modules.get(row, col) === 1);
    }
  }
  return { size, modules };
}
