/**
 * @file stage — unit tests for the delegating host API (api.ts).
 *
 * One suite per domain file; the facade has a single domain file (`api.ts`). Builds a mock context
 * whose `require` returns spies for `session`/`sync`/`intent` and asserts each method is a single,
 * unwrapped delegation — plus the no-`transport`-call guard and the five forwarding hooks.
 */
import { describe, it } from "vitest";

describe("createStageApi — delegation", () => {
  it.todo(
    "createRoom() calls session.createRoom() exactly once and returns its RoomDescriptor verbatim (synchronous, no await)"
  );
  it.todo(
    "mutate('scores', recipe) calls sync.mutate once with the same ns and the same recipe reference (identity)"
  );
  it.todo("broadcast() calls sync.broadcast() exactly once");
  it.todo(
    "onIntent('move', h) calls intent.onIntent once with the same name and a wrapping callback"
  );
  it.todo(
    "the onIntent wrapper, driven with (payload, { peerId, cSeq }), invokes h with exactly (payload, peerId)"
  );
  it.todo("onIntent returns the unsubscribe function that intent.onIntent returned");
  it.todo("roster() returns session.roster()'s array verbatim");
});

describe("createStageApi — no transport call", () => {
  it.todo(
    "require(transportPlugin) is never invoked by any facade method (transport is visibility-only)"
  );
});

describe("stagePlugin — forwarding hooks", () => {
  it.todo("room:peer-joined re-emits the same name with the identical payload object via ctx.emit");
  it.todo("room:peer-left re-emits the same name with the identical payload object via ctx.emit");
  it.todo(
    "room:host-reconnecting re-emits the same name with the identical payload object via ctx.emit"
  );
  it.todo("room:sync-ready re-emits the same name with the identical payload object via ctx.emit");
  it.todo(
    "room:network-warning forwards each of the three reason values (ice-failed | rendezvous-unreachable | channel-closed) unchanged"
  );
});
