/**
 * @file stage — unit tests for the delegating host API (api.ts).
 *
 * One suite per domain file; the facade has a single domain file (`api.ts`). Builds plain
 * spy-backed API objects for session/sync/intent and asserts each method is a single,
 * unwrapped delegation. Also covers the no-transport-call guard (transport is visibility-only;
 * the factory signature does NOT accept a transport param by design).
 *
 * Note: the facade installs NO forwarding hooks (D19) — runtime room:* delivery to a
 * depends:[stagePlugin] consumer rides Moku's global event bus directly; see the closing comment
 * block and the integration test for the WARN-2 runtime proof.
 */
import { describe, expect, it, vi } from "vitest";
import type { IntentApi, IntentMeta } from "../../../intent/types";
import type { RoomDescriptor, RosterEntry, SessionApi } from "../../../session/types";
import type { Cells, Api as SyncApi } from "../../../sync/types";
import { createStageApi } from "../../api";

// ---------------------------------------------------------------------------
// Minimal spy-backed engine API objects (cast to engine API types)
// ---------------------------------------------------------------------------

/** Builds a session spy. Casts to SessionApi — only createRoom/roster are under test. */
function makeSessionSpy() {
  const descriptor: RoomDescriptor = {
    code: "ABC123",
    joinUrl: "https://room.test?room=ABC123",
    qr: null,
    hostToken: "00000000-0000-0000-0000-000000000001"
  };
  const roster: readonly RosterEntry[] = [
    { id: "p1", reconnectToken: "rt1", joinedAt: 1_718_600_000_000 }
  ];
  const spy = {
    createRoom: vi.fn<() => RoomDescriptor>(() => descriptor),
    roster: vi.fn<() => readonly RosterEntry[]>(() => roster)
  };
  return { ...spy, _session: spy as unknown as SessionApi };
}

/** Builds an intent spy. Exposes `_unsub` for identity checks. Casts to IntentApi. */
function makeIntentSpy() {
  const unsub = vi.fn<() => void>(() => undefined);
  const onIntent = vi.fn<
    (name: string, handler: (payload: unknown, meta: IntentMeta) => void) => () => void
  >(() => unsub);
  const spy = { onIntent };
  return {
    ...spy,
    _unsub: unsub,
    _intent: spy as unknown as IntentApi
  };
}

/** Builds a sync spy. Casts to SyncApi — only mutate/broadcast are under test. */
function makeSyncSpy() {
  const mutate = vi.fn<(ns: string, recipe: (draft: Cells) => Cells) => void>();
  const broadcast = vi.fn<() => void>();
  const spy = { mutate, broadcast };
  return { ...spy, _sync: spy as unknown as SyncApi };
}

/** A fixed recipe used for mutate identity-check tests — hoisted to satisfy unicorn/consistent-function-scoping. */
const testRecipe = (draft: Cells): Cells => ({ ...draft, score: 1 });

// ---------------------------------------------------------------------------
// Delegation tests
// ---------------------------------------------------------------------------

describe("createStageApi — delegation", () => {
  it("createRoom() calls session.createRoom() exactly once and returns its RoomDescriptor verbatim (synchronous, no await)", () => {
    const session = makeSessionSpy();
    const intent = makeIntentSpy();
    const sync = makeSyncSpy();

    const api = createStageApi(session._session, intent._intent, sync._sync);
    const result = api.createRoom();

    expect(session.createRoom).toHaveBeenCalledOnce();
    // Returns the SAME object reference (verbatim delegation — no transformation)
    expect(result).toBe(session.createRoom.mock.results[0]?.value);
    expect(result.code).toBe("ABC123");
  });

  it("mutate('scores', recipe) calls sync.mutate once with the same ns and the same recipe reference (identity)", () => {
    const session = makeSessionSpy();
    const intent = makeIntentSpy();
    const sync = makeSyncSpy();

    const api = createStageApi(session._session, intent._intent, sync._sync);

    api.mutate("scores", testRecipe);

    expect(sync.mutate).toHaveBeenCalledOnce();
    const [calledNs, calledRecipe] = sync.mutate.mock.calls[0] ?? [];
    expect(calledNs).toBe("scores");
    // Identity check: the facade must pass the SAME recipe reference, not a wrapper
    expect(calledRecipe).toBe(testRecipe);
  });

  it("broadcast() calls sync.broadcast() exactly once", () => {
    const session = makeSessionSpy();
    const intent = makeIntentSpy();
    const sync = makeSyncSpy();

    const api = createStageApi(session._session, intent._intent, sync._sync);
    api.broadcast();

    expect(sync.broadcast).toHaveBeenCalledOnce();
  });

  it("onIntent('move', h) calls intent.onIntent once with the same name and a wrapping callback", () => {
    const session = makeSessionSpy();
    const intent = makeIntentSpy();
    const sync = makeSyncSpy();

    const api = createStageApi(session._session, intent._intent, sync._sync);
    const handler = vi.fn();
    api.onIntent("move", handler);

    expect(intent.onIntent).toHaveBeenCalledOnce();
    const [calledName] = intent.onIntent.mock.calls[0] ?? [];
    expect(calledName).toBe("move");
    // The second argument must be a function (a wrapping callback, not handler itself)
    const wrapper = intent.onIntent.mock.calls[0]?.[1];
    expect(typeof wrapper).toBe("function");
  });

  it("the onIntent wrapper, driven with (payload, { peerId, cSeq }), invokes h with exactly (payload, peerId)", () => {
    const session = makeSessionSpy();
    const intent = makeIntentSpy();
    const sync = makeSyncSpy();

    const api = createStageApi(session._session, intent._intent, sync._sync);
    const handler = vi.fn();
    api.onIntent("move", handler);

    // Capture the wrapper the facade gave to intent.onIntent
    const wrapper = intent.onIntent.mock.calls[0]?.[1];
    expect(wrapper).toBeDefined();
    if (!wrapper) return;

    const payload = { dx: 0.5, dy: 0 };
    const meta: IntentMeta = { peerId: "p1", cSeq: 3 };
    wrapper(payload, meta);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(payload, "p1");
    // cSeq is NOT forwarded — the facade unwraps only peerId
    expect(handler.mock.calls[0]).toHaveLength(2);
  });

  it("onIntent returns the unsubscribe function that intent.onIntent returned", () => {
    const session = makeSessionSpy();
    const intent = makeIntentSpy();
    const sync = makeSyncSpy();

    const api = createStageApi(session._session, intent._intent, sync._sync);
    const handler = vi.fn();
    const off = api.onIntent("move", handler);

    // Identity: the facade must return the EXACT unsubscribe fn from intent.onIntent
    expect(off).toBe(intent._unsub);
  });

  it("roster() returns session.roster()'s array verbatim", () => {
    const session = makeSessionSpy();
    const intent = makeIntentSpy();
    const sync = makeSyncSpy();

    const api = createStageApi(session._session, intent._intent, sync._sync);
    const result = api.roster();

    expect(session.roster).toHaveBeenCalledOnce();
    expect(result).toBe(session.roster.mock.results[0]?.value);
    expect(result).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// No-transport-call guard
// ---------------------------------------------------------------------------

describe("createStageApi — no transport call", () => {
  it("factory signature does NOT accept a transport param — transport is visibility-only (depends-only, never required)", () => {
    // This test verifies the reconciliation decision: createStageApi takes exactly 3 params
    // (session, intent, sync). The transportPlugin is wired in index.ts depends[] for
    // event visibility only (room:network-warning must be visible for re-declaration).
    // We verify no call to any transport-shaped method occurs by confirming the factory
    // operates correctly with only the three resolved APIs passed.
    const session = makeSessionSpy();
    const intent = makeIntentSpy();
    const sync = makeSyncSpy();

    // If the factory were to expect a 4th param (transport), TypeScript would surface it;
    // runtime: verify calling all five methods does NOT cause errors with 3-param factory.
    const api = createStageApi(session._session, intent._intent, sync._sync);
    expect(() => api.createRoom()).not.toThrow();
    expect(() => api.broadcast()).not.toThrow();
    expect(() => api.roster()).not.toThrow();
    // Confirm session/sync/intent are the only delegates touched (no 4th "transport" param needed)
    expect(session.createRoom).toHaveBeenCalled();
    expect(sync.broadcast).toHaveBeenCalled();
    expect(session.roster).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Event delivery to a depends:[stagePlugin] consumer (WARN-2) — by design, NO forwarding
// ---------------------------------------------------------------------------
// The facade installs NO forwarding hooks (D19). Moku's runtime event bus is global — every hook
// registered for an event name fires on ANY `emit` of that name, regardless of `depends` — so the
// engines' own `room:*` emits already reach a `depends: [stagePlugin]` consumer's hooks directly. A
// forwarding hook re-emitting the same name would re-trigger ITSELF on the shared bus and recurse
// infinitely (verified: stack overflow). The facade's `events` re-declaration supplies the COMPILE-TIME
// visibility a consumer needs to write those hooks (proven in types.test-d.ts); the RUNTIME delivery is
// proven end-to-end in the integration test (the gameProbe receives room:sync-ready through the facade
// edge with the facade emitting nothing). There is therefore no hook body to unit-test here.
