/**
 * @file Room-code generation (§6.2). A 6-char code (`ROOM_CODE_LENGTH`) drawn from
 * `crypto.getRandomValues` over a confusable-free alphanumeric alphabet (excludes `0/O`, `1/I/L`). No
 * server uniqueness check — collisions are an accepted per-room rendezvous risk for the home-LAN target
 * (D2/D6). Pure module: a seeded RNG can be injected in tests.
 * @see ../README.md
 */

/**
 * Generates a fresh room code: `ROOM_CODE_LENGTH` characters drawn uniformly from the confusable-free
 * alphabet via `crypto.getRandomValues` (§6.2). The optional `randomBytes` seam lets unit tests inject a
 * deterministic source.
 *
 * @param randomBytes - Optional injectable RNG returning `n` random bytes; defaults to `crypto.getRandomValues`.
 * @throws {Error} Always — skeleton stub.
 * @example
 * ```ts
 * const code = generateRoomCode(); // e.g. "G7K2QF"
 * ```
 */
export function generateRoomCode(randomBytes?: (n: number) => Uint8Array): string {
  throw new Error("not implemented");
}
