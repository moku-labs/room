/**
 * @file Integration tests via the `inMemory` adapter (D13 — no real RTCPeerConnection): full lifecycle
 * (createApp(stage) -> start -> createRoom -> wire N controllers -> room:peer-joined per join, 9th
 * full), leave -> room:peer-left, the host-reload scenario (persist -> tear down host -> re-create against
 * the same inMemory room + persisted record -> room:host-reconnecting + buffered-intent flush in cSeq
 * order + duplicate drop + fresh re-baseline), onStop via the teardownRegistry (flushNow wrote + dispose
 * cleared timers + entry deleted), and D14 per-instance teardown (stop ONE of two apps; the other is
 * untouched).
 */

import { describe, it } from "vitest";

describe("session integration (inMemory)", () => {
  it.todo(
    "full lifecycle: createRoom -> N controllers join -> room:peer-joined per join; roster reflects all"
  );
  it.todo("rejects the 9th join with JoinResult{ok:false,reason:'full'} and no event");
  it.todo("leave() emits room:peer-left on the host and shrinks the roster");
  it.todo(
    "host-reload: re-creating against the same room + persisted record emits room:host-reconnecting"
  );
  it.todo(
    "host-reload: buffered intents flush in cSeq order and duplicates (cSeq <= lastApplied) are dropped"
  );
  it.todo(
    "host-reload: a fresh snapshot re-baselines (RecoveryWelcomeFrame.sSeq === sSeqAtSnapshot)"
  );
  it.todo(
    "start -> API -> stop: onStop flushNow wrote the final record and dispose cleared all timers"
  );
  it.todo("start -> API -> stop: the teardownRegistry entry is deleted after stop()");
  it.todo(
    "D14: stopping ONE of two app instances leaves the OTHER app's recoveryPhase/timers untouched"
  );
});
