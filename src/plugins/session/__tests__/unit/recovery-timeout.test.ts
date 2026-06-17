/**
 * @file Unit tests for `recovery/timeout.ts`: reconnectTimeoutMs elapses -> phase "host-absent" ->
 * "degraded"; on a simulated iOS UA the degrade surfaces the "rescan QR" path (recoveryPhase()==="degraded",
 * rejoin() available); on non-iOS, auto-rejoin is attempted before degrade (ctx.env/UA injected).
 */

import { describe, it } from "vitest";

describe("recovery/timeout", () => {
  it.todo("transitions host-absent -> degraded when reconnectTimeoutMs elapses");
  it.todo("on a simulated iOS UA, degrades to the rescan-QR path (recoveryPhase === degraded)");
  it.todo("on a non-iOS UA, attempts auto-rejoin before degrading");
});
