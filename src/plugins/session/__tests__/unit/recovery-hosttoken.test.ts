/**
 * @file Unit tests for `recovery/hosttoken.ts`: createRoom mints a crypto.randomUUID() hostToken; a
 * controller stores the token from the host; RecoveryHelloFrame -> RecoveryWelcomeFrame accepts a matching
 * token and REJECTS a mismatched one (peer-side verification, no server — §5.2).
 */

import { describe, it } from "vitest";

describe("recovery/hosttoken", () => {
  it.todo("mints a crypto.randomUUID() hostToken on createRoom");
  it.todo("stores the host's token on the controller");
  it.todo("accepts a matching token (Hello -> Welcome)");
  it.todo("rejects a mismatched token (peer-side verification, no server)");
});
