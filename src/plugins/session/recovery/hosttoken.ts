/**
 * @file Host-token mint + PEER-SIDE verification (§5.1/§5.2). `mintHostToken` (`crypto.randomUUID()`) runs
 * once on `createRoom`. Verification is fully client-side — there is NO server validator (trusted threat
 * model, D6): a controller stores the host's token and the `RecoveryHelloFrame` <-> `RecoveryWelcomeFrame`
 * handshake accepts a matching token and REJECTS a mismatched one.
 * @see ../README.md
 */

/**
 * Mints the host re-entry credential (`crypto.randomUUID()`, §5.1) on `createRoom`. Stored alongside the
 * snapshot and presented to controllers for peer-side verification on re-entry.
 *
 * @throws {Error} Always — skeleton stub.
 * @example
 * ```ts
 * state.hostToken = mintHostToken();
 * ```
 */
export function mintHostToken(): string {
  throw new Error("not implemented");
}

/**
 * Peer-side host-token verification (§5.2, no server validator — D6). Returns whether `presented` (from an
 * inbound `RecoveryHelloFrame`/`RecoveryWelcomeFrame`) matches the locally-stored `expected` token. A
 * mismatch is rejected.
 *
 * @param presented - The token carried in the inbound recovery frame.
 * @param expected - The token this device stored (host's minted token / controller's last-seen token).
 * @throws {Error} Always — skeleton stub.
 * @example
 * ```ts
 * if (!verifyHostToken(frame.hostToken, state.hostToken)) return; // reject
 * ```
 */
export function verifyHostToken(presented: string, expected: string): boolean {
  throw new Error("not implemented");
}
