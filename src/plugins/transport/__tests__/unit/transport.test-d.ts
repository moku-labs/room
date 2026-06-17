/**
 * @file Type-level tests for the transport public surface.
 * @see ../../types.ts
 */
import { describe, it } from "vitest";

describe("transport types", () => {
  it.todo(
    "wire().send accepts every Frame variant and rejects a non-Frame object (@ts-expect-error)"
  );
  it.todo("connect requires { role, selfId, code } and rejects a missing code (@ts-expect-error)");
  it.todo(
    "ctx.emit accepts 'room:network-warning' with a valid reason and rejects an invalid reason"
  );
  it.todo("ctx.emit rejects any other room:* event (transport owns only room:network-warning)");
  it.todo("inMemory() and publicRendezvous() are both assignable to Signaling (D12)");
  it.todo("SignalMsg/IceCandidateInit carry no lib.dom types (compile in a DOM-free project)");
});
