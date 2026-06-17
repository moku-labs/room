/**
 * @file Integration tests — full createApp wiring over the inMemory adapter.
 * @see ../../index.ts
 */
import { describe, it } from "vitest";

describe("transport integration (inMemory)", () => {
  it.todo("app.start() runs onStart but opens NO connections at boot");
  it.todo("a controller connect makes both peers() lists reflect the link");
  it.todo(
    "a controller wire().send is delivered to the host's Wire.on consumer as the exact IntentFrame"
  );
  it.todo("a host broadcast reaches the controller");
  it.todo("chunked snapshots reassemble end-to-end across the inMemory pair");
  it.todo("app.stop() closes everything, leaves the session, and clears all timers (fake timers)");

  // D14 per-instance isolation
  it.todo("with two apps connected on one bus, hostApp.stop() leaves the controller app untouched");

  // emit assertion
  it.todo("a forced dead peer emits exactly one {reason:'channel-closed'} (de-dup)");
});
