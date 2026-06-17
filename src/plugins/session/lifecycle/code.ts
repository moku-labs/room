/**
 * @file Room-code generation (§6.2). A 6-char code (`ROOM_CODE_LENGTH`) drawn from
 * `crypto.getRandomValues` over a confusable-free alphanumeric alphabet (excludes `0/O`, `1/I/L`). No
 * server uniqueness check — collisions are an accepted per-room rendezvous risk for the home-LAN target
 * (D2/D6). Pure module: a seeded RNG can be injected in tests.
 * @see ../README.md
 */

import { ROOM_CODE_LENGTH } from "../../../contracts";

/**
 * The confusable-free alphanumeric alphabet for room codes (§6.2). Excludes visually ambiguous glyphs:
 * `0` (vs `O`), `1` (vs `I`, `L`), `O`, `I`, `L`. 27 chars remain from A-Z2-9.
 */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/**
 * Generates a fresh room code: `ROOM_CODE_LENGTH` characters drawn uniformly from the confusable-free
 * alphabet via `crypto.getRandomValues` (§6.2). The optional `randomBytes` seam lets unit tests inject a
 * deterministic source.
 *
 * @param randomBytes - Optional injectable RNG returning `n` random bytes; defaults to `crypto.getRandomValues`.
 * @returns A 6-character room code drawn from the confusable-free alphabet.
 * @example
 * ```ts
 * const code = generateRoomCode(); // e.g. "G7K2QF"
 * ```
 */
export function generateRoomCode(randomBytes?: (n: number) => Uint8Array): string {
  const getRandBytes =
    randomBytes ??
    ((n: number): Uint8Array => {
      const buf = new Uint8Array(n);
      globalThis.crypto.getRandomValues(buf);
      return buf;
    });

  // Draw more bytes than needed to avoid modulo bias. We use rejection sampling:
  // discard bytes >= floor(256 / alphabetLen) * alphabetLen to eliminate bias.
  const alphabetLength = ALPHABET.length;
  const maxUsable = Math.floor(256 / alphabetLength) * alphabetLength;

  let code = "";
  while (code.length < ROOM_CODE_LENGTH) {
    const bytes = getRandBytes(ROOM_CODE_LENGTH * 2);
    for (const byte of bytes) {
      if (byte < maxUsable) {
        code += ALPHABET[byte % alphabetLength];
        if (code.length === ROOM_CODE_LENGTH) break;
      }
    }
  }
  return code;
}
