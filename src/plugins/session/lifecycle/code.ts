/**
 * @file Room-code generation (§6.2). A `codeLength`-char code (default `ROOM_CODE_LENGTH` = 6) drawn from
 * `crypto.getRandomValues` over a confusable-free alphanumeric alphabet (excludes `0/O`, `1/I/L`). No
 * server uniqueness check — collisions are an accepted per-room rendezvous risk for the home-LAN target
 * (D2/D6). Pure module: a seeded RNG and custom length can be injected in tests. `serverSignaling`
 * deployments SHOULD pass `length: 8` (~57 bits) to resist room-code enumeration (D24, Cycle 2).
 * @see ../README.md
 */

import { ROOM_CODE_LENGTH } from "../../transport/protocol";

/**
 * The confusable-free alphanumeric alphabet for room codes (§6.2). Excludes visually ambiguous glyphs:
 * `0` (vs `O`), `1` (vs `I`, `L`), `O`, `I`, `L`. 27 chars remain from A-Z2-9.
 */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/**
 * Generates a fresh room code: `length` characters drawn uniformly from the confusable-free
 * alphabet via `crypto.getRandomValues` (§6.2). The optional `randomBytes` seam lets unit tests inject a
 * deterministic source. The optional `length` parameter defaults to `ROOM_CODE_LENGTH` (6) so existing
 * callers are unaffected; `serverSignaling` deployments pass `8` for ~57 bits of entropy (D24, Cycle 2).
 *
 * @param randomBytes - Optional injectable RNG returning `n` random bytes; defaults to `crypto.getRandomValues`.
 * @param length - Number of characters to generate. Defaults to `ROOM_CODE_LENGTH` (6).
 * @returns A room code of `length` characters drawn from the confusable-free alphabet.
 * @example
 * ```ts
 * const code = generateRoomCode(); // e.g. "G7K2QF" (6 chars, default)
 * const longCode = generateRoomCode(undefined, 8); // e.g. "G7K2QFAB" (8 chars, serverSignaling)
 * ```
 */
export function generateRoomCode(
  randomBytes?: (n: number) => Uint8Array,
  length: number = ROOM_CODE_LENGTH
): string {
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
  while (code.length < length) {
    const bytes = getRandBytes(length * 2);
    for (const byte of bytes) {
      if (byte < maxUsable) {
        code += ALPHABET[byte % alphabetLength];
        if (code.length === length) break;
      }
    }
  }
  return code;
}
