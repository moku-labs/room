/**
 * @file Unit tests for chunking/reassembly, backpressure, and the heartbeat.
 * @see ../../channel.ts
 */
import { describe, it } from "vitest";

describe("channel — chunking", () => {
  it.todo("a Frame just under maxMessageBytes serializes to a single un-enveloped message");
  it.todo("a Frame just over maxMessageBytes serializes to N chunks");
  it.todo("N chunks reassemble byte-identically to the original Frame");
});

describe("channel — backpressure", () => {
  it.todo("pauses a peer when bufferedAmount exceeds the ~64 KiB threshold");
  it.todo("resumes the peer on bufferedamountlow");
  it.todo("backpressure is per-peer — one slow controller does not stall the others");
});

describe("channel — heartbeat", () => {
  it.todo("declares a peer dead after heartbeatTimeoutMs with no pong (fake timers)");
  it.todo("emits room:network-warning {reason:'channel-closed'} on a dead peer");
  it.todo("de-dups the channel-closed warning per peer-epoch");
  it.todo("handles ping/pong internally — they never reach the frame consumer");
});
