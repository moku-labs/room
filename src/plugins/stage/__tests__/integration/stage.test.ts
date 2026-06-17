/**
 * @file stage — integration tests (full wiring via createApp + inMemory signaling, D13/contracts §1.3).
 *
 * Composes roomPlugins.stage + a throwaway game plugin (depends:[stagePlugin]) as the host and N
 * roomPlugins.controller instances as controllers on the same in-memory bus (no real
 * RTCPeerConnection). Exercises the lifecycle, an end-to-end intent → mutate → delta round-trip, and
 * proves room:sync-ready forwarding reaches a real dependent through the facade edge.
 */
import { describe, it } from "vitest";

describe("stage — createApp integration (inMemory signaling)", () => {
  it.todo("await app.start() → app.stage.createRoom() returns a RoomDescriptor synchronously");
  it.todo(
    "a controller intent driven through inMemory fires the host's onIntent handler with (payload, peerId)"
  );
  it.todo(
    "a subsequent app.stage.mutate(...) produces a delta the controller's read-only replica applies (assert on synced state)"
  );
  it.todo("createApp → start → stage methods → stop completes cleanly; app.stop() resolves");
  it.todo(
    "the facade contributes no teardown work — stopping twice / stopping a never-started app surfaces engine behavior, not a facade error"
  );
  it.todo(
    "room:sync-ready forwarding end-to-end: the game plugin's room:sync-ready hook fires after the first snapshot applies"
  );
});
