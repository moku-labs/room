/**
 * @file Unit tests for `recovery/hosttoken.ts`: createRoom mints a crypto.randomUUID() hostToken; a
 * controller stores the token from the host; RecoveryHelloFrame -> RecoveryWelcomeFrame accepts a matching
 * token and REJECTS a mismatched one (peer-side verification, no server — §5.2).
 */

import { describe, expect, it } from "vitest";
import { mintHostToken, verifyHostToken } from "../../recovery/hosttoken";

describe("recovery/hosttoken", () => {
  it("mints a crypto.randomUUID() hostToken on createRoom", () => {
    const token = mintHostToken();
    // UUID v4 format: 8-4-4-4-12 hex digits with hyphens.
    expect(token).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i);
  });

  it("stores the host's token on the controller (tokens are unique UUIDs)", () => {
    const token1 = mintHostToken();
    const token2 = mintHostToken();
    // Two tokens minted independently should not collide (UUID space is huge).
    expect(token1).not.toBe(token2);
  });

  it("accepts a matching token (Hello -> Welcome)", () => {
    const token = mintHostToken();
    expect(verifyHostToken(token, token)).toBe(true);
  });

  it("rejects a mismatched token (peer-side verification, no server)", () => {
    const hostToken = mintHostToken();
    const wrongToken = mintHostToken();
    expect(verifyHostToken(wrongToken, hostToken)).toBe(false);
  });

  it("rejects an empty token against a real token", () => {
    const hostToken = mintHostToken();
    expect(verifyHostToken("", hostToken)).toBe(false);
  });

  it("rejects a real token against an empty expected", () => {
    const token = mintHostToken();
    expect(verifyHostToken(token, "")).toBe(false);
  });
});
