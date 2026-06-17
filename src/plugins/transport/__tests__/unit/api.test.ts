/**
 * @file Unit tests for the transport API against a mock context.
 * @see ../../api.ts
 */
import { describe, it } from "vitest";

describe("createTransportApi", () => {
  it.todo("connect('host') calls signaling.join with passive:false");
  it.todo("connect('controller') calls signaling.join with passive:true");
  it.todo("connect rejects + emits 'rendezvous-unreachable' when no relay is reachable");
  it.todo("wire() returns the same stable Wire instance every call");
  it.todo("peers() reflects the live peer map");
  it.todo("disconnect removes exactly one peer");
  it.todo("close() leaves the signaling session and clears state");
});
