/**
 * @file Unit tests for the inMemory signaling adapter (DOM-free contract proof, D12).
 * @see ../../adapters/in-memory.ts
 */
import { describe, it } from "vitest";

describe("inMemory adapter", () => {
  it.todo("two sessions on the same code mutually fire onPeer");
  it.todo("send/onSignal deliver SignalMsgs in-process with no RTCPeerConnection");
  it.todo("leave() is idempotent");
});
