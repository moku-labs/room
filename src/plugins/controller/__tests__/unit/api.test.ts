/**
 * @file Unit tests for the controller facade delegation factory (`createControllerApi`). One suite per
 * public method of `ControllerApi`: delegation correctness (spy engines via a mock `ctx.require`),
 * `joinRoom` JoinResult → resolve/throw mapping, wake-lock paths (supported / unsupported / denied /
 * idempotent), and the "no gameplay through emit" boundary check. Mock-context factories per moku-testing.
 */
import { describe, it } from "vitest";

describe("createControllerApi — delegation correctness", () => {
  it.todo("joinRoom('K7P2Q9') calls session.joinRoom('K7P2Q9') exactly once with NO passive arg");
  it.todo("joinRoom resolves void when session.joinRoom returns { ok: true, selfId }");
  it.todo("read('scores') calls sync.read('scores') and returns its value unchanged");
  it.todo("on('round', cb) registers via sync.subscribe and returns the unsubscribe fn unchanged");
  it.todo(
    "intent('move', { dx: 1 }) calls intent.intent('move', { dx: 1 }) exactly once, returns void"
  );
  it.todo("pass-through is transparent — no payload mutation and no extra engine calls");
});

describe("createControllerApi — joinRoom JoinResult mapping", () => {
  it.todo("{ ok: false, reason: 'full' } rejects with Error whose message is 'full' (§6.2)");
  it.todo("{ ok: false, reason: 'not-found' } rejects with Error('not-found')");
  it.todo("{ ok: false, reason: 'unreachable' } rejects with Error('unreachable')");
  it.todo(
    "{ ok: true } resolves void — the rejection is never swallowed nor converted to an event"
  );
});

describe("createControllerApi — wake lock (stubbed navigator.wakeLock)", () => {
  it.todo(
    "supported: requestWakeLock() calls navigator.wakeLock.request('screen') once, resolves true"
  );
  it.todo(
    "supported: a second requestWakeLock() is a no-op (idempotent) and does not request twice"
  );
  it.todo("releaseWakeLock() calls sentinel.release() once and clears the closure handle");
  it.todo("releaseWakeLock() is a no-op when no sentinel is held");
  it.todo(
    "unsupported: navigator.wakeLock absent → requestWakeLock() resolves false, never throws"
  );
  it.todo("unsupported: releaseWakeLock() resolves with no error when wakeLock is absent");
  it.todo("denied: request rejecting (NotAllowedError) resolves false, never propagates");
});

describe("createControllerApi — no gameplay through emit", () => {
  it.todo(
    "intent(...) never calls ctx.emit (mock emit spy has zero calls) — spec/07 §3 / spec/11 §2.7"
  );
});
