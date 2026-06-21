/**
 * @file Unit tests for `createSessionApi` (api.ts) with a mock `SessionDeps` (transport stubbed via
 * `requireTransport`, `emit`/`log` as `vi.fn()`, a fresh `createSessionState()`). Drives every method +
 * branch: `createRoom` (mint/connect/throw-when-active), `joinRoom` (early `unreachable` + selfId mint +
 * `not-found` delegation), `leave` (idempotent no-op + full reset), `rejoin` (throw-without-roomCode +
 * delegation), `roster` (sorted defensive copy), `self`, `hostId` (host/controller/empty), `persistSnapshot`
 * (host vs controller no-op), and `recoveryPhase`. The unit project runs under `node` (no DOM), so
 * `armPersistence`/`recordSnapshot` degrade to no-ops on storage — no persistence mock is needed.
 */

import { describe, expect, it, vi } from "vitest";
import type { RosterEntry, Snapshot } from "../../../../contracts";
import { createSessionApi } from "../../api";
import * as persistence from "../../recovery/persistence";
import { createSessionState } from "../../state";
import type { SessionConfig, SessionDeps } from "../../types";

const testConfig: Readonly<SessionConfig> = {
  joinUrlBase: "https://tv.example",
  generateQr: false,
  maxControllers: 8,
  snapshotDebounceMs: 500,
  reconnectTimeoutMs: 10_000,
  intentBufferMax: 256,
  intentBufferMaxAgeMs: 8000,
  storageKeyPrefix: "test.room"
};

type MockTransport = ReturnType<SessionDeps["requireTransport"]>;

/**
 * Builds a fresh mock transport. `connectResolves` controls whether `transport.connect` resolves
 * (default) or rejects — rejecting lets `doJoinRoom` settle synchronously to `not-found` without a
 * hanging promise.
 *
 * @param connectResolves - When `false`, `connect` rejects (drives the join `not-found` path).
 * @returns A vi-mocked `TransportApi`.
 */
function makeMockTransport(connectResolves = true): MockTransport {
  const mockWire = { send: vi.fn(), broadcast: vi.fn(), on: vi.fn() };
  const connect = connectResolves
    ? vi.fn().mockResolvedValue(undefined)
    : vi.fn().mockRejectedValue(new Error("not-found"));
  return {
    connect,
    wire: vi.fn().mockReturnValue(mockWire),
    disconnect: vi.fn(),
    reclaimToken: vi.fn().mockReturnValue(null),
    peers: vi.fn().mockReturnValue([]),
    close: vi.fn().mockResolvedValue(undefined),
    onPeerConnected: vi.fn(),
    onPeerLost: vi.fn()
  } as unknown as MockTransport;
}

/**
 * Builds a `SessionDeps` over a fresh `createSessionState()` (role `"none"`), the test config, and a mock
 * transport. Mirrors the `makeDeps` pattern in `handlers.test.ts`/`recovery-timeout.test.ts`.
 *
 * @param overrides - Partial `SessionDeps` to override (e.g. a custom `requireTransport`).
 * @returns A `SessionDeps` bundle for `createSessionApi`.
 */
function makeDeps(overrides?: Partial<SessionDeps>): SessionDeps {
  const state = createSessionState();
  const transport = makeMockTransport();
  return {
    state,
    config: testConfig,
    emit: { peerJoined: vi.fn(), peerLeft: vi.fn(), hostReconnecting: vi.fn() },
    log: { warn: vi.fn() },
    requireTransport: vi.fn().mockReturnValue(transport),
    ...overrides
  };
}

function makeRosterEntry(id: string, joinedAt: number): RosterEntry {
  return { id, reconnectToken: `rt-${id}`, joinedAt };
}

describe("createSessionApi", () => {
  describe("createRoom", () => {
    it("mints a room from role 'none': 6-char code, non-empty hostToken, joinUrl, qr null", () => {
      const deps = makeDeps();
      const api = createSessionApi(deps);

      const descriptor = api.createRoom();

      expect(descriptor.code).toHaveLength(6);
      expect(descriptor.hostToken).not.toBe("");
      expect(descriptor.joinUrl).toBe(`https://tv.example?room=${descriptor.code}`);
      expect(descriptor.qr).toBeNull();
    });

    it("transitions state to host and stores selfId/roomCode/hostToken/persistHandle", () => {
      const deps = makeDeps();
      const api = createSessionApi(deps);

      const descriptor = api.createRoom();

      expect(deps.state.role).toBe("host");
      expect(deps.state.selfId).not.toBe("");
      expect(deps.state.roomCode).toBe(descriptor.code);
      expect(deps.state.hostToken).toBe(descriptor.hostToken);
      expect(deps.state.recovery.persistHandle).not.toBeNull();
    });

    it("tells transport to connect as the host hub (role 'host', code, selfId)", () => {
      const deps = makeDeps();
      const transport = deps.requireTransport();
      const api = createSessionApi(deps);

      const descriptor = api.createRoom();

      expect(vi.mocked(transport.connect)).toHaveBeenCalledWith({
        role: "host",
        selfId: deps.state.selfId,
        code: descriptor.code
      });
    });

    it("swallows a transport.connect rejection (best-effort, no throw)", async () => {
      const transport = makeMockTransport(false); // connect rejects
      const deps = makeDeps({ requireTransport: vi.fn().mockReturnValue(transport) });
      const api = createSessionApi(deps);

      expect(() => api.createRoom()).not.toThrow();
      // Allow the rejected connect promise's .catch to settle without an unhandled rejection.
      await Promise.resolve();
      expect(deps.state.role).toBe("host");
    });

    it("throws when a room is already active (role !== 'none')", () => {
      const deps = makeDeps();
      deps.state.role = "host";
      const api = createSessionApi(deps);

      expect(() => api.createRoom()).toThrow(/already active/i);
    });

    it("throws when role is 'controller' as well", () => {
      const deps = makeDeps();
      deps.state.role = "controller";
      const api = createSessionApi(deps);

      expect(() => api.createRoom()).toThrow();
    });
  });

  describe("qr", () => {
    /** Test config with QR generation ON (the host/browser path; the shared `testConfig` keeps it OFF). */
    const qrOnConfig: Readonly<SessionConfig> = { ...testConfig, generateQr: true };

    it("resolves null when no room is active (roomCode empty), even with generateQr on", async () => {
      const deps = makeDeps({ config: qrOnConfig }); // role 'none', roomCode ''
      const api = createSessionApi(deps);

      await expect(api.qr()).resolves.toBeNull();
    });

    it("resolves null when generateQr is false, even with an active room", async () => {
      const deps = makeDeps(); // testConfig.generateQr === false
      deps.state.roomCode = "G7K2QF";
      const api = createSessionApi(deps);

      await expect(api.qr()).resolves.toBeNull();
    });

    it("resolves a QrMatrix for the active room's join URL when generateQr is true", async () => {
      const deps = makeDeps({ config: qrOnConfig });
      deps.state.roomCode = "G7K2QF";
      const api = createSessionApi(deps);

      const matrix = await api.qr();

      expect(matrix).not.toBeNull();
      if (!matrix) return;
      expect(matrix.size).toBeGreaterThan(0);
      expect(matrix.modules).toHaveLength(matrix.size * matrix.size);
    });

    it("renders the QR for a room opened via createRoom (createRoom sync + descriptor.qr null → qr() matrix)", async () => {
      const deps = makeDeps({ config: qrOnConfig });
      const api = createSessionApi(deps);

      const descriptor = api.createRoom();
      expect(descriptor.qr).toBeNull(); // sync path never carries the async matrix

      const matrix = await api.qr();
      expect(matrix).not.toBeNull();
    });
  });

  describe("joinRoom", () => {
    it("returns { ok:false, reason:'unreachable' } when already in a room", async () => {
      const deps = makeDeps();
      deps.state.role = "host";
      const api = createSessionApi(deps);

      const result = await api.joinRoom("ABC234");

      expect(result).toEqual({ ok: false, reason: "unreachable" });
    });

    it("does NOT mint a selfId or call connect on the early unreachable path", async () => {
      const deps = makeDeps();
      deps.state.role = "controller";
      const transport = deps.requireTransport();
      const api = createSessionApi(deps);

      await api.joinRoom("ABC234");

      expect(deps.state.selfId).toBe("");
      expect(vi.mocked(transport.connect)).not.toHaveBeenCalled();
    });

    it("from role 'none': mints selfId, sets role 'controller', calls connect, resolves not-found on reject", async () => {
      const transport = makeMockTransport(false); // connect rejects → doJoinRoom resolves not-found
      const deps = makeDeps({ requireTransport: vi.fn().mockReturnValue(transport) });
      const api = createSessionApi(deps);

      const result = await api.joinRoom("ABC234");

      expect(result).toEqual({ ok: false, reason: "not-found" });
      expect(deps.state.selfId).not.toBe("");
      expect(deps.state.role).toBe("controller");
      expect(deps.state.roomCode).toBe("ABC234");
      expect(vi.mocked(transport.connect)).toHaveBeenCalledWith({
        role: "controller",
        selfId: deps.state.selfId,
        code: "ABC234"
      });
    });

    it("reuses a pre-existing selfId instead of minting a new one", async () => {
      const transport = makeMockTransport(false);
      const deps = makeDeps({ requireTransport: vi.fn().mockReturnValue(transport) });
      deps.state.selfId = "pre-existing-id";
      const api = createSessionApi(deps);

      await api.joinRoom("ABC234");

      expect(deps.state.selfId).toBe("pre-existing-id");
    });

    it("resolves { ok:false, reason:'unreachable' } when the reconnect timeout elapses", async () => {
      vi.useFakeTimers();
      const transport = makeMockTransport(true); // connect resolves, but no peer ever connects
      const deps = makeDeps({ requireTransport: vi.fn().mockReturnValue(transport) });
      const api = createSessionApi(deps);

      const pending = api.joinRoom("ABC234");
      await vi.advanceTimersByTimeAsync(testConfig.reconnectTimeoutMs + 10);
      const result = await pending;

      expect(result).toEqual({ ok: false, reason: "unreachable" });
      vi.useRealTimers();
    });
  });

  describe("leave", () => {
    it("is an idempotent no-op when role is 'none' (does not close transport)", async () => {
      const deps = makeDeps();
      const transport = deps.requireTransport();
      const api = createSessionApi(deps);

      await api.leave();

      expect(vi.mocked(transport.close)).not.toHaveBeenCalled();
    });

    it("closes transport and resets all state to idle when in a room", async () => {
      const deps = makeDeps();
      const transport = deps.requireTransport();
      // Seed an active host session with non-idle fields.
      deps.state.role = "host";
      deps.state.selfId = "host-id";
      deps.state.roomCode = "ABC234";
      deps.state.hostToken = "token-xyz";
      deps.state.roster = { "p-1": makeRosterEntry("p-1", 1000) };
      deps.state.recovery.phase = "host-absent";
      deps.state.recovery.buffer = [{ intent: { t: "intent", op: {} }, ts: 1 } as never];
      deps.state.recovery.reconnectDeadline = 999;
      const api = createSessionApi(deps);

      await api.leave();

      expect(vi.mocked(transport.close)).toHaveBeenCalledTimes(1);
      expect(deps.state.role).toBe("none");
      expect(deps.state.roomCode).toBe("");
      expect(deps.state.hostToken).toBe("");
      expect(deps.state.roster).toEqual({});
      expect(deps.state.selfId).toBe("");
      expect(deps.state.recovery.phase).toBe("stable");
      expect(deps.state.recovery.buffer).toEqual([]);
      expect(deps.state.recovery.reconnectDeadline).toBe(0);
    });

    it("resets cleanly from a controller session too", async () => {
      const deps = makeDeps();
      const transport = deps.requireTransport();
      deps.state.role = "controller";
      deps.state.roomCode = "ABC234";
      const api = createSessionApi(deps);

      await api.leave();

      expect(vi.mocked(transport.close)).toHaveBeenCalledTimes(1);
      expect(deps.state.role).toBe("none");
    });
  });

  describe("rejoin", () => {
    it("throws when there is no stored roomCode to rejoin", async () => {
      const deps = makeDeps(); // roomCode === ""
      const api = createSessionApi(deps);

      await expect(api.rejoin()).rejects.toThrow(/Cannot rejoin/i);
    });

    it("delegates to the join handshake against the stored roomCode (not-found on reject)", async () => {
      const transport = makeMockTransport(false); // connect rejects → resolves not-found
      const deps = makeDeps({ requireTransport: vi.fn().mockReturnValue(transport) });
      deps.state.roomCode = "ABC234";
      const api = createSessionApi(deps);

      const result = await api.rejoin();

      expect(result).toEqual({ ok: false, reason: "not-found" });
      expect(vi.mocked(transport.connect)).toHaveBeenCalledWith({
        role: "controller",
        selfId: deps.state.selfId,
        code: "ABC234"
      });
    });
  });

  describe("roster", () => {
    it("returns a copy sorted by joinedAt ascending", () => {
      const deps = makeDeps();
      deps.state.roster = {
        late: makeRosterEntry("late", 2000),
        early: makeRosterEntry("early", 1000)
      };
      const api = createSessionApi(deps);

      const seats = api.roster();

      expect(seats.map(s => s.id)).toEqual(["early", "late"]);
    });

    it("returns a defensive copy (mutating the result does not affect state)", () => {
      const deps = makeDeps();
      deps.state.roster = { "p-1": makeRosterEntry("p-1", 1000) };
      const api = createSessionApi(deps);

      const seats = api.roster();
      (seats as RosterEntry[]).push(makeRosterEntry("p-2", 2000));

      expect(Object.keys(deps.state.roster)).toEqual(["p-1"]);
    });
  });

  describe("self", () => {
    it("returns the current selfId, role, and roomCode", () => {
      const deps = makeDeps();
      deps.state.selfId = "me";
      deps.state.role = "controller";
      deps.state.roomCode = "ABC234";
      const api = createSessionApi(deps);

      expect(api.self()).toEqual({
        selfId: "me",
        role: "controller",
        roomCode: "ABC234"
      });
    });

    it("returns idle defaults before any room is created/joined", () => {
      const deps = makeDeps();
      const api = createSessionApi(deps);

      expect(api.self()).toEqual({ selfId: "", role: "none", roomCode: "" });
    });
  });

  describe("hostId", () => {
    it("returns selfId when this device is the host", () => {
      const deps = makeDeps();
      deps.state.role = "host";
      deps.state.selfId = "host-self";
      const api = createSessionApi(deps);

      expect(api.hostId()).toBe("host-self");
    });

    it("returns the stored _hostId when this device is a controller", () => {
      const deps = makeDeps();
      deps.state.role = "controller";
      (deps.state as unknown as { _hostId?: string | null })._hostId = "the-host";
      const api = createSessionApi(deps);

      expect(api.hostId()).toBe("the-host");
    });

    it("returns '' for a controller with no host connected yet (_hostId null)", () => {
      const deps = makeDeps();
      deps.state.role = "controller";
      (deps.state as unknown as { _hostId?: string | null })._hostId = null;
      const api = createSessionApi(deps);

      expect(api.hostId()).toBe("");
    });

    it("returns '' for a controller when _hostId is unset (undefined)", () => {
      const deps = makeDeps();
      deps.state.role = "controller";
      const api = createSessionApi(deps);

      expect(api.hostId()).toBe("");
    });
  });

  describe("persistSnapshot", () => {
    const snapshot: Snapshot = { scores: { a: 1 } };

    it("is a no-op on a controller (does not stamp sSeqAtSnapshot)", () => {
      const deps = makeDeps();
      deps.state.role = "controller";
      const api = createSessionApi(deps);

      api.persistSnapshot(snapshot, 7);

      expect(deps.state.sSeqAtSnapshot).toBe(0);
    });

    it("is a no-op when role is 'none'", () => {
      const deps = makeDeps();
      const api = createSessionApi(deps);

      expect(() => api.persistSnapshot(snapshot, 7)).not.toThrow();
      expect(deps.state.sSeqAtSnapshot).toBe(0);
    });

    it("records the snapshot on the host (stamps sSeqAtSnapshot, no throw)", () => {
      const deps = makeDeps();
      deps.state.role = "host";
      deps.state.roomCode = "ABC234";
      deps.state.hostToken = "token-xyz";
      const api = createSessionApi(deps);

      expect(() => api.persistSnapshot(snapshot, 42)).not.toThrow();
      expect(deps.state.sSeqAtSnapshot).toBe(42);
    });

    it("records through an armed persist handle on the host (createRoom then persist)", () => {
      const deps = makeDeps();
      const api = createSessionApi(deps);
      api.createRoom(); // arms persistHandle, sets role host

      expect(() => api.persistSnapshot(snapshot, 13)).not.toThrow();
      expect(deps.state.sSeqAtSnapshot).toBe(13);
    });

    it("captures the transport reclaim token into the persisted record (serverSignaling)", () => {
      const transport = makeMockTransport();
      vi.mocked(transport.reclaimToken).mockReturnValue("tok-DO");
      const deps = makeDeps({ requireTransport: vi.fn().mockReturnValue(transport) });
      deps.state.role = "host";
      deps.state.roomCode = "ABC234";
      const recordSpy = vi.spyOn(persistence, "recordSnapshot");
      const api = createSessionApi(deps);

      api.persistSnapshot(snapshot, 9);

      expect(recordSpy).toHaveBeenCalledWith(
        deps,
        expect.objectContaining({ reclaimToken: "tok-DO" })
      );
    });

    it("omits reclaimToken from the record when transport has none (publicRendezvous/inMemory)", () => {
      const deps = makeDeps(); // default mock transport returns reclaimToken() → null
      deps.state.role = "host";
      deps.state.roomCode = "ABC234";
      const recordSpy = vi.spyOn(persistence, "recordSnapshot");
      recordSpy.mockClear(); // vi.spyOn reuses the underlying mock across tests — start from a clean call log
      const api = createSessionApi(deps);

      api.persistSnapshot(snapshot, 4);

      const record = recordSpy.mock.calls[0]?.[1];
      expect(record).toBeDefined();
      expect(record && "reclaimToken" in record).toBe(false);
    });
  });

  describe("recoveryPhase", () => {
    it("returns the current recovery phase", () => {
      const deps = makeDeps();
      const api = createSessionApi(deps);

      expect(api.recoveryPhase()).toBe("stable");

      deps.state.recovery.phase = "degraded";
      expect(api.recoveryPhase()).toBe("degraded");
    });
  });
});
