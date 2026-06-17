/**
 * @file Integration tests for the controller facade via full `createApp` wiring (`@moku-labs/web`), the
 * `inMemory()` signaling adapter (deterministic, no `RTCPeerConnection` — 00-contracts §1.3, D13), and the
 * host's `log` + `env` core plugins. Stands up ONE stage app + N controller apps over a shared in-memory
 * bus and drives them by direct `app.controller.*` / `app.stage.*` calls, asserting on synced state.
 */
import { describe, it } from "vitest";

describe("controller integration — join → sync → intent round-trip", () => {
  it.todo("controller.joinRoom(code) resolves over a shared inMemory() bus");
  it.todo(
    "after the host seeds a slice, room:sync-ready fires and controller.read(ns) returns the host value"
  );
  it.todo(
    "controller.intent('move', { dx: 1 }) is applied host-side (authoritative state changed)"
  );
  it.todo("the applied intent re-broadcasts back into the controller's read-only replica");
});

describe("controller integration — event forwarding through depends: [controllerPlugin] (WARN-2 runtime)", () => {
  it.todo("room:peer-joined fires on the consumer's hook when a controller joins");
  it.todo("room:sync-ready fires on the first snapshot");
  it.todo("room:peer-left fires on a controller drop");
  it.todo("room:host-reconnecting fires on a simulated host reload");
  it.todo("room:network-warning fires on a transport hard-failure");
});

describe("controller integration — on(ns, cb) reactivity", () => {
  it.todo("subscribe before the host mutates; callback fires with the new value in sSeq order");
  it.todo("callback stops firing after off()");
});
