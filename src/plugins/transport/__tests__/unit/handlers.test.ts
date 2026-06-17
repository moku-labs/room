/**
 * @file Unit tests for the signaling-glue handlers.
 * @see ../../handlers.ts
 */
import { describe, it } from "vitest";

describe("transport handlers", () => {
  it.todo("applying an inbound offer SignalMsg triggers an answer send");
  it.todo("an inbound candidate SignalMsg is added via addIceCandidate");
  it.todo("stays joined until iceConnectionState is connected, then leaves (trickle ICE)");
  it.todo("onPeerLeave during a handshake is bookkeeping-only and emits no Moku event");
});
