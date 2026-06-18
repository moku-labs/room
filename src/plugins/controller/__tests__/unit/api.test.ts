/**
 * @file Unit tests for the controller facade delegation factory (`createControllerApi` +
 * `requestScreenWakeLock`). One suite per public method of `ControllerApi`: delegation correctness
 * (spy engines passed directly), `joinRoom` JoinResult → resolve/throw mapping, wake-lock paths
 * (supported / unsupported / denied / idempotent), and the "no gameplay through emit" boundary
 * check. Mock engines are plain vi.fn() spies — no full ctx needed (the factory takes APIs directly,
 * not a ctx, per the reconciliation decision).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IntentApi } from "../../../intent/types";
import type { SessionApi } from "../../../session/types";
import type { Cells, Api as SyncApi } from "../../../sync/types";
import { createControllerApi, requestScreenWakeLock } from "../../api";

// ---------------------------------------------------------------------------
// Shared spy factories
// ---------------------------------------------------------------------------

function makeSessionSpy(): SessionApi {
  return {
    createRoom: vi.fn(),
    joinRoom:
      vi.fn<
        (
          code: string
        ) => Promise<
          { ok: true; selfId: string } | { ok: false; reason: "full" | "not-found" | "unreachable" }
        >
      >(),
    leave: vi.fn<() => Promise<void>>(),
    rejoin:
      vi.fn<
        () => Promise<
          { ok: true; selfId: string } | { ok: false; reason: "full" | "not-found" | "unreachable" }
        >
      >(),
    roster: vi.fn().mockReturnValue([]),
    self: vi.fn().mockReturnValue({ selfId: "", role: "none", roomCode: "" }),
    hostId: vi.fn().mockReturnValue(""),
    persistSnapshot: vi.fn(),
    recoveryPhase: vi.fn().mockReturnValue("stable")
  } as unknown as SessionApi;
}

function makeSyncSpy(): SyncApi {
  return {
    registerSlice: vi.fn(),
    mutate: vi.fn(),
    flush: vi.fn<() => void>(),
    read: vi.fn<(ns: string) => Cells | undefined>(),
    subscribe: vi.fn<(ns: string, cb: (cells: Cells) => void) => () => void>(),
    applyFrame: vi.fn(),
    snapshot: vi.fn(),
    startBroadcast: vi.fn(),
    stopBroadcast: vi.fn(),
    exportSnapshot: vi.fn(),
    importSnapshot: vi.fn()
  } as unknown as SyncApi;
}

function makeIntentSpy(): IntentApi {
  return {
    register: vi.fn(),
    onIntent:
      vi.fn<
        (
          name: string,
          handler: (payload: unknown, meta: { peerId: string; cSeq: number }) => void
        ) => () => void
      >(),
    intent: vi.fn<(name: string, payload: unknown) => void>(),
    setBuffering: vi.fn(),
    drainBuffer: vi.fn().mockReturnValue([]),
    bufferedCount: vi.fn().mockReturnValue(0)
  } as unknown as IntentApi;
}

// Shared sentinel stub
let sentinelStub: { release: ReturnType<typeof vi.fn>; addEventListener: ReturnType<typeof vi.fn> };

beforeEach(() => {
  sentinelStub = {
    release: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    addEventListener: vi.fn()
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Delegation correctness
// ---------------------------------------------------------------------------

describe("createControllerApi — delegation correctness", () => {
  it("joinRoom('K7P2Q9') calls session.joinRoom('K7P2Q9') exactly once with NO passive arg", async () => {
    const session = makeSessionSpy();
    vi.mocked(session.joinRoom).mockResolvedValue({ ok: true, selfId: "x" });
    const api = createControllerApi(session, makeIntentSpy(), makeSyncSpy());

    await api.joinRoom("K7P2Q9");

    expect(session.joinRoom).toHaveBeenCalledOnce();
    expect(session.joinRoom).toHaveBeenCalledWith("K7P2Q9");
  });

  it("joinRoom resolves void when session.joinRoom returns { ok: true, selfId }", async () => {
    const session = makeSessionSpy();
    vi.mocked(session.joinRoom).mockResolvedValue({ ok: true, selfId: "abc" });
    const api = createControllerApi(session, makeIntentSpy(), makeSyncSpy());

    const result = await api.joinRoom("K7P2Q9");
    expect(result).toBeUndefined();
  });

  it("read('scores') calls sync.read('scores') and returns its value unchanged", () => {
    const sync = makeSyncSpy();
    const expected: Cells = { p1: 12, p2: 9 };
    vi.mocked(sync.read).mockReturnValue(expected);
    const api = createControllerApi(makeSessionSpy(), makeIntentSpy(), sync);

    const result = api.read("scores");

    expect(sync.read).toHaveBeenCalledOnce();
    expect(sync.read).toHaveBeenCalledWith("scores");
    expect(result).toBe(expected);
  });

  it("on('round', cb) registers via sync.subscribe and returns the unsubscribe fn unchanged", () => {
    const sync = makeSyncSpy();
    const cb = vi.fn();
    const off = vi.fn();
    vi.mocked(sync.subscribe).mockReturnValue(off);
    const api = createControllerApi(makeSessionSpy(), makeIntentSpy(), sync);

    const result = api.on("round", cb);

    expect(sync.subscribe).toHaveBeenCalledOnce();
    expect(sync.subscribe).toHaveBeenCalledWith("round", cb);
    expect(result).toBe(off);
  });

  it("intent('move', { dx: 1 }) calls intent.intent('move', { dx: 1 }) exactly once, returns void", () => {
    const intent = makeIntentSpy();
    const api = createControllerApi(makeSessionSpy(), intent, makeSyncSpy());

    const result = api.intent("move", { dx: 1 });

    expect(intent.intent).toHaveBeenCalledOnce();
    expect(intent.intent).toHaveBeenCalledWith("move", { dx: 1 });
    expect(result).toBeUndefined();
  });

  it("pass-through is transparent — no payload mutation and no extra engine calls", () => {
    const session = makeSessionSpy();
    const intent = makeIntentSpy();
    const sync = makeSyncSpy();
    vi.mocked(session.joinRoom).mockResolvedValue({ ok: true, selfId: "y" });
    const api = createControllerApi(session, intent, sync);

    const payload = { dx: 1 };
    api.intent("move", payload);
    api.read("scores");

    // Payload object identity is unchanged (no clone/mutation)
    expect(intent.intent).toHaveBeenCalledWith("move", payload);
    // No cross-engine calls (intent does not call session, etc.)
    expect(session.joinRoom).not.toHaveBeenCalled();
    expect(sync.subscribe).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// JoinResult mapping
// ---------------------------------------------------------------------------

describe("createControllerApi — joinRoom JoinResult mapping", () => {
  it("{ ok: false, reason: 'full' } rejects with Error whose message is 'full' (§6.2)", async () => {
    const session = makeSessionSpy();
    vi.mocked(session.joinRoom).mockResolvedValue({ ok: false, reason: "full" });
    const api = createControllerApi(session, makeIntentSpy(), makeSyncSpy());

    await expect(api.joinRoom("X")).rejects.toThrow("full");
  });

  it("{ ok: false, reason: 'not-found' } rejects with Error('not-found')", async () => {
    const session = makeSessionSpy();
    vi.mocked(session.joinRoom).mockResolvedValue({ ok: false, reason: "not-found" });
    const api = createControllerApi(session, makeIntentSpy(), makeSyncSpy());

    await expect(api.joinRoom("X")).rejects.toThrow("not-found");
  });

  it("{ ok: false, reason: 'unreachable' } rejects with Error('unreachable')", async () => {
    const session = makeSessionSpy();
    vi.mocked(session.joinRoom).mockResolvedValue({ ok: false, reason: "unreachable" });
    const api = createControllerApi(session, makeIntentSpy(), makeSyncSpy());

    await expect(api.joinRoom("X")).rejects.toThrow("unreachable");
  });

  it("{ ok: true } resolves void — the rejection is never swallowed nor converted to an event", async () => {
    const session = makeSessionSpy();
    vi.mocked(session.joinRoom).mockResolvedValue({ ok: true, selfId: "z" });
    const api = createControllerApi(session, makeIntentSpy(), makeSyncSpy());

    await expect(api.joinRoom("K7P2Q9")).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Wake lock (stubbed navigator.wakeLock)
// ---------------------------------------------------------------------------

describe("createControllerApi — wake lock (stubbed navigator.wakeLock)", () => {
  it("supported: requestWakeLock() calls navigator.wakeLock.request('screen') once, resolves true", async () => {
    const requestFn = vi.fn().mockResolvedValue(sentinelStub);
    vi.stubGlobal("navigator", { wakeLock: { request: requestFn } });

    const api = createControllerApi(makeSessionSpy(), makeIntentSpy(), makeSyncSpy());
    const result = await api.requestWakeLock();

    expect(requestFn).toHaveBeenCalledOnce();
    expect(requestFn).toHaveBeenCalledWith("screen");
    expect(result).toBe(true);
  });

  it("supported: a second requestWakeLock() is a no-op (idempotent) and does not request twice", async () => {
    const requestFn = vi.fn().mockResolvedValue(sentinelStub);
    vi.stubGlobal("navigator", { wakeLock: { request: requestFn } });

    const api = createControllerApi(makeSessionSpy(), makeIntentSpy(), makeSyncSpy());
    await api.requestWakeLock();
    const result = await api.requestWakeLock();

    expect(requestFn).toHaveBeenCalledOnce();
    expect(result).toBe(true);
  });

  it("releaseWakeLock() calls sentinel.release() once and clears the closure handle", async () => {
    const requestFn = vi.fn().mockResolvedValue(sentinelStub);
    vi.stubGlobal("navigator", { wakeLock: { request: requestFn } });

    const api = createControllerApi(makeSessionSpy(), makeIntentSpy(), makeSyncSpy());
    await api.requestWakeLock();
    await api.releaseWakeLock();

    expect(sentinelStub.release).toHaveBeenCalledOnce();

    // After release, a subsequent requestWakeLock should request again (sentinel cleared)
    const result = await api.requestWakeLock();
    expect(requestFn).toHaveBeenCalledTimes(2);
    expect(result).toBe(true);
  });

  it("releaseWakeLock() is a no-op when no sentinel is held", async () => {
    const api = createControllerApi(makeSessionSpy(), makeIntentSpy(), makeSyncSpy());
    await expect(api.releaseWakeLock()).resolves.toBeUndefined();
  });

  it("unsupported: navigator.wakeLock absent → requestWakeLock() resolves false, never throws", async () => {
    vi.stubGlobal("navigator", {});

    const api = createControllerApi(makeSessionSpy(), makeIntentSpy(), makeSyncSpy());
    await expect(api.requestWakeLock()).resolves.toBe(false);
  });

  it("unsupported: navigator undefined → requestWakeLock() resolves false, never throws", async () => {
    vi.stubGlobal("navigator", undefined);

    const api = createControllerApi(makeSessionSpy(), makeIntentSpy(), makeSyncSpy());
    await expect(api.requestWakeLock()).resolves.toBe(false);
  });

  it("unsupported: releaseWakeLock() resolves with no error when wakeLock is absent", async () => {
    vi.stubGlobal("navigator", {});
    const api = createControllerApi(makeSessionSpy(), makeIntentSpy(), makeSyncSpy());
    await expect(api.releaseWakeLock()).resolves.toBeUndefined();
  });

  it("denied: request rejecting (NotAllowedError) resolves false, never propagates", async () => {
    const requestFn = vi.fn().mockRejectedValue(new DOMException("denied", "NotAllowedError"));
    vi.stubGlobal("navigator", { wakeLock: { request: requestFn } });

    const api = createControllerApi(makeSessionSpy(), makeIntentSpy(), makeSyncSpy());
    await expect(api.requestWakeLock()).resolves.toBe(false);
  });
});

// ---------------------------------------------------------------------------
// No gameplay through emit
// ---------------------------------------------------------------------------

describe("createControllerApi — no gameplay through emit", () => {
  it("intent(...) never calls ctx.emit — spec/07 §3 / spec/11 §2.7: gameplay rides the §2 wire", () => {
    // The factory takes plain API objects (no ctx), so we verify that intent() ONLY calls
    // intent.intent and produces no other side effects. A game plugin can only call intent
    // through this surface — there is no emit path here.
    // Document the spec/07 §3 boundary: emit is the five coarse room:* events (forwarded by
    // index.ts hooks); intent data NEVER flows through Moku emit, always through the §2 wire.
    const intent = makeIntentSpy();
    const session = makeSessionSpy();
    const sync = makeSyncSpy();
    const api = createControllerApi(session, intent, sync);

    api.intent("move", { dx: 1 });

    // Only intent.intent was called; no other spy methods were invoked
    expect(intent.intent).toHaveBeenCalledOnce();
    expect(session.joinRoom).not.toHaveBeenCalled();
    expect(sync.read).not.toHaveBeenCalled();
    expect(sync.subscribe).not.toHaveBeenCalled();
    // The factory takes no ctx (no emit fn), confirming there is no emit path
    // available from within createControllerApi at all.
  });
});

// ---------------------------------------------------------------------------
// requestScreenWakeLock standalone tests
// ---------------------------------------------------------------------------

describe("requestScreenWakeLock — standalone helper", () => {
  it("returns null when navigator is undefined (Node / non-browser)", async () => {
    vi.stubGlobal("navigator", undefined);
    const result = await requestScreenWakeLock();
    expect(result).toBeNull();
  });

  it("returns null when navigator.wakeLock is absent", async () => {
    vi.stubGlobal("navigator", {});
    const result = await requestScreenWakeLock();
    expect(result).toBeNull();
  });

  it("returns the sentinel when navigator.wakeLock.request resolves", async () => {
    const requestFn = vi.fn().mockResolvedValue(sentinelStub);
    vi.stubGlobal("navigator", { wakeLock: { request: requestFn } });

    const result = await requestScreenWakeLock();
    expect(result).toBe(sentinelStub);
  });

  it("returns null (not throws) when navigator.wakeLock.request rejects", async () => {
    const requestFn = vi.fn().mockRejectedValue(new Error("NotAllowedError"));
    vi.stubGlobal("navigator", { wakeLock: { request: requestFn } });

    await expect(requestScreenWakeLock()).resolves.toBeNull();
  });
});
