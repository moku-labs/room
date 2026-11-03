/**
 * @file Unit tests for `lifecycle/self-id.ts` and for what `settleJoin` does with the saved id: the rules the
 * integration walk does not reach. One room keeps one id per code, a device with no usable `sessionStorage` still
 * joins, and only a settled `full` forgets the id.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { TransportApi } from "../../../transport/types";
import { sessionConfig } from "../../config";
import { settleJoin } from "../../lifecycle/join";
import { forgetSelfId, loadOrMintSelfId } from "../../lifecycle/self-id";
import { createSessionState } from "../../state";
import type { SessionDeps } from "../../types";

/** Builds the deps these functions read: state, config, and a transport whose `close` succeeds. */
function makeDeps(): SessionDeps {
  return {
    state: createSessionState(),
    config: { ...sessionConfig, storageKeyPrefix: "test.room" },
    emit: { peerJoined: vi.fn(), peerLeft: vi.fn(), hostReconnecting: vi.fn(), hostBack: vi.fn() },
    log: { warn: vi.fn() },
    requireTransport: () =>
      ({ close: vi.fn().mockResolvedValue(undefined) }) as unknown as TransportApi
  };
}

/** A `sessionStorage` stub over a `Map`, installed as the global. */
function stubTab(): Map<string, string> {
  const store = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string): string | null => store.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      store.set(key, value);
    },
    removeItem: (key: string): void => {
      store.delete(key);
    }
  });
  return store;
}

/** A tab holding the id of room `AAAAAA`, with a first join of that room pending. */
function pendingJoin(): { deps: SessionDeps; store: Map<string, string> } {
  const store = stubTab();
  const deps = makeDeps();
  deps.state.selfId = loadOrMintSelfId(deps, "AAAAAA");
  deps.state.roomCode = "AAAAAA";
  deps.state.role = "controller";
  deps.state._pendingJoinResolve = vi.fn();
  return { deps, store };
}

describe("loadOrMintSelfId", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("saves one id per room code, under the configured prefix, and loads it back", () => {
    const store = stubTab();
    const deps = makeDeps();

    const first = loadOrMintSelfId(deps, "AAAAAA");
    const second = loadOrMintSelfId(deps, "BBBBBB");

    expect(first).not.toBe(second);
    expect(store.get("test.room.self.AAAAAA")).toBe(first);
    expect(store.get("test.room.self.BBBBBB")).toBe(second);
    expect(loadOrMintSelfId(deps, "AAAAAA")).toBe(first);
  });

  it("with storage: a missing key mints, whatever id the state still holds", () => {
    stubTab();
    const deps = makeDeps();
    deps.state.selfId = "refused-id";

    expect(loadOrMintSelfId(deps, "AAAAAA")).not.toBe("refused-id");
  });

  it("with no sessionStorage: keeps the id the state holds, and mints only when it holds none", () => {
    const deps = makeDeps();

    const minted = loadOrMintSelfId(deps, "AAAAAA");
    expect(minted).not.toBe("");

    deps.state.selfId = "kept-id";
    expect(loadOrMintSelfId(deps, "AAAAAA")).toBe("kept-id");
  });

  it("a storage that refuses still gives an id: a blocked read, and a write over quota", () => {
    const deps = makeDeps();
    vi.stubGlobal("sessionStorage", {
      getItem: () => {
        throw new Error("SecurityError");
      }
    });
    expect(loadOrMintSelfId(deps, "AAAAAA")).not.toBe("");

    vi.stubGlobal("sessionStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      }
    });
    expect(loadOrMintSelfId(deps, "AAAAAA")).not.toBe("");
  });
});

describe("forgetSelfId", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("removes one room's id and leaves the others", () => {
    const store = stubTab();
    const deps = makeDeps();
    loadOrMintSelfId(deps, "AAAAAA");
    loadOrMintSelfId(deps, "BBBBBB");

    forgetSelfId(deps, "AAAAAA");

    expect([...store.keys()]).toEqual(["test.room.self.BBBBBB"]);
  });

  it("does not throw where there is no sessionStorage", () => {
    expect(() => forgetSelfId(makeDeps(), "AAAAAA")).not.toThrow();
  });
});

describe("settleJoin and the saved id", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a timed-out or not-found join keeps the id: the retry is the same player", () => {
    const unreachable = pendingJoin();
    settleJoin(unreachable.deps, { ok: false, reason: "unreachable" });
    expect(unreachable.store.size).toBe(1);

    const notFound = pendingJoin();
    settleJoin(notFound.deps, { ok: false, reason: "not-found" });
    expect(notFound.store.size).toBe(1);
  });

  it("an admitted join keeps the id", () => {
    const { deps, store } = pendingJoin();

    settleJoin(deps, { ok: true, selfId: deps.state.selfId });

    expect(store.size).toBe(1);
  });

  it("a room-full frame with no join pending changes nothing: a seated phone keeps its id", () => {
    const { deps, store } = pendingJoin();
    deps.state._pendingJoinResolve = null;

    settleJoin(deps, { ok: false, reason: "full" });

    expect(store.size).toBe(1);
  });

  it("a full rejoin removes the id too, and keeps the room", () => {
    const { deps, store } = pendingJoin();
    deps.state._pendingJoinKeepsRoom = true;

    settleJoin(deps, { ok: false, reason: "full" });

    expect(store.size).toBe(0);
    expect(deps.state.roomCode).toBe("AAAAAA");
  });
});
