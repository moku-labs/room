/**
 * @file Unit tests for `handlers.ts` factories with a mock ctx (transport stubbed via `require`,
 * `emit: vi.fn()`): each handler performs the right roster mutation + the right `room:*` emission, and NO
 * wire frame is ever routed through `emit` (assert `emit` is only ever called with `room:*` names).
 */

import { describe, expect, it, vi } from "vitest";
import type { Frame, RosterEntry } from "../../../../contracts";
import {
  handleHostChannelLost,
  handlePeerConnected,
  handlePeerLost,
  handleRecoveryFrame,
  handleStarTopologyViolation
} from "../../handlers";
import { createSessionState } from "../../state";
import type { SessionDeps } from "../../types";

function makeRosterEntry(id: string, joinedAt = 1000): RosterEntry {
  return { id, reconnectToken: `rt-${id}`, joinedAt };
}

function makeDeps(overrides?: Partial<SessionDeps>): SessionDeps {
  const state = createSessionState();
  state.role = "host";
  state.selfId = "host-id";

  const mockWire = {
    send: vi.fn(),
    broadcast: vi.fn(),
    on: vi.fn()
  };
  const mockTransport = {
    connect: vi.fn().mockResolvedValue(undefined),
    wire: vi.fn().mockReturnValue(mockWire),
    disconnect: vi.fn(),
    peers: vi.fn().mockReturnValue([]),
    close: vi.fn().mockResolvedValue(undefined),
    onPeerConnected: vi.fn(),
    onPeerLost: vi.fn()
  };

  return {
    state,
    config: {
      joinUrlBase: "",
      generateQr: false,
      maxControllers: 8,
      snapshotDebounceMs: 500,
      reconnectTimeoutMs: 10_000,
      intentBufferMax: 256,
      intentBufferMaxAgeMs: 8000,
      storageKeyPrefix: "moku.room"
    },
    emit: {
      peerJoined: vi.fn(),
      peerLeft: vi.fn(),
      hostReconnecting: vi.fn()
    },
    log: { warn: vi.fn() },
    requireTransport: vi.fn().mockReturnValue(mockTransport),
    ...overrides
  };
}

describe("handlers", () => {
  it("handlePeerConnected: upserts roster + emits room:peer-joined", () => {
    const deps = makeDeps();
    const entry = makeRosterEntry("p-1");

    handlePeerConnected(deps)("p-1", entry);

    expect(deps.state.roster["p-1"]).toEqual(entry);
    expect(deps.emit.peerJoined).toHaveBeenCalledWith({ peerId: "p-1" });
    expect(deps.emit.peerLeft).not.toHaveBeenCalled();
    expect(deps.emit.hostReconnecting).not.toHaveBeenCalled();
  });

  it("handlePeerConnected: rejects the 9th controller without emitting", () => {
    const deps = makeDeps();
    // Fill to cap.
    for (let i = 1; i <= 8; i++) {
      handlePeerConnected(deps)(`p-${i}`, makeRosterEntry(`p-${i}`, i * 1000));
    }
    vi.mocked(deps.emit.peerJoined).mockClear();

    // 9th controller.
    handlePeerConnected(deps)("p-9", makeRosterEntry("p-9", 9000));

    expect(deps.emit.peerJoined).not.toHaveBeenCalled();
    expect(deps.state.roster["p-9"]).toBeUndefined();
    // Verify disconnect was called on the rejected peer.
    const transport = deps.requireTransport();
    expect(vi.mocked(transport.disconnect)).toHaveBeenCalledWith("p-9");
  });

  it("handlePeerLost: removes from roster + emits room:peer-left", () => {
    const deps = makeDeps();
    handlePeerConnected(deps)("p-1", makeRosterEntry("p-1"));

    handlePeerLost(deps)("p-1");

    expect(deps.state.roster["p-1"]).toBeUndefined();
    expect(deps.emit.peerLeft).toHaveBeenCalledWith({ peerId: "p-1" });
  });

  it("handlePeerLost: no-op for unknown peer (idempotent)", () => {
    const deps = makeDeps();
    handlePeerLost(deps)("unknown");
    expect(deps.emit.peerLeft).not.toHaveBeenCalled();
  });

  it("handleHostChannelLost: enters host-absent, arms the reconnect timer", () => {
    const deps = makeDeps();
    deps.state.role = "controller";
    deps.state.roomCode = "TEST01";

    vi.useFakeTimers();
    handleHostChannelLost(deps)();

    expect(deps.state.recovery.phase).toBe("host-absent");
    expect(deps.state.recovery.timer).not.toBeNull();
    vi.useRealTimers();
  });

  it("handleRecoveryFrame: dispatches Hello correctly (host verifies token, replies Welcome)", () => {
    const deps = makeDeps();
    deps.state.role = "host";
    deps.state.hostToken = "token-abc";
    deps.state.sSeqAtSnapshot = 5;

    const handler = handleRecoveryFrame(deps);
    const helloFrame: Frame = { t: "recovery-hello", hostToken: "token-abc", peerId: "p-1" };
    handler("p-1", helloFrame);

    const transport = deps.requireTransport();
    const wire = transport.wire();
    expect(vi.mocked(wire.send)).toHaveBeenCalledWith("p-1", {
      t: "recovery-welcome",
      hostToken: "token-abc",
      sSeq: 5
    });
  });

  it("handleRecoveryFrame: rejects mismatched token on Hello (no response)", () => {
    const deps = makeDeps();
    deps.state.role = "host";
    deps.state.hostToken = "token-abc";

    const handler = handleRecoveryFrame(deps);
    handler("p-1", { t: "recovery-hello", hostToken: "WRONG-TOKEN", peerId: "p-1" });

    const transport = deps.requireTransport();
    const wire = transport.wire();
    expect(vi.mocked(wire.send)).not.toHaveBeenCalled();
  });

  it("handleRecoveryFrame: controller processes Welcome (sends Flush, moves to reconciling)", () => {
    const deps = makeDeps();
    deps.state.role = "controller";
    deps.state.hostToken = "token-abc";
    deps.state.recovery.phase = "host-absent";

    const handler = handleRecoveryFrame(deps);
    handler("host-id", { t: "recovery-welcome", hostToken: "token-abc", sSeq: 10 });

    expect(deps.state.recovery.phase).toBe("reconciling");
    const transport = deps.requireTransport();
    const wire = transport.wire();
    expect(vi.mocked(wire.send)).toHaveBeenCalledWith(
      "host-id",
      expect.objectContaining({
        t: "recovery-flush"
      })
    );
  });

  it("handleRecoveryFrame: ignores non-recovery frames", () => {
    const deps = makeDeps();
    const handler = handleRecoveryFrame(deps);
    const pingFrame: Frame = { t: "ping", ts: 12_345 };
    // Should not throw and should not call emit.
    expect(() => handler("p-1", pingFrame)).not.toThrow();
    expect(deps.emit.peerJoined).not.toHaveBeenCalled();
    expect(deps.emit.peerLeft).not.toHaveBeenCalled();
    expect(deps.emit.hostReconnecting).not.toHaveBeenCalled();
  });

  it("handleStarTopologyViolation: rejects a controller<->controller channel (no event)", () => {
    const deps = makeDeps();
    deps.state.selfId = "host-id";
    deps.state.role = "host";

    handleStarTopologyViolation(deps)("p-1", "p-2");

    // A warning should have been logged via ctx.log, but no event emitted.
    expect(deps.log.warn).toHaveBeenCalled();
    expect(deps.emit.peerJoined).not.toHaveBeenCalled();
    expect(deps.emit.peerLeft).not.toHaveBeenCalled();
    expect(deps.emit.hostReconnecting).not.toHaveBeenCalled();
  });

  it("emit is only ever called with room:* event names (no wire frames via emit)", () => {
    const deps = makeDeps();
    const peerJoined = vi.mocked(deps.emit.peerJoined);
    const peerLeft = vi.mocked(deps.emit.peerLeft);
    const hostReconnecting = vi.mocked(deps.emit.hostReconnecting);

    // Run all handlers.
    handlePeerConnected(deps)("p-1", makeRosterEntry("p-1"));
    handlePeerLost(deps)("p-1");
    const handler = handleRecoveryFrame(deps);
    handler("p-1", { t: "ping", ts: 0 });

    // Verify all emit calls are only the three room:* events.
    for (const call of [
      ...peerJoined.mock.calls,
      ...peerLeft.mock.calls,
      ...hostReconnecting.mock.calls
    ]) {
      // Each call is the payload — keys should not look like wire frames (no 't' key).
      const payload = call[0] as Record<string, unknown>;
      expect("t" in payload ? "wire-frame" : "event-payload").toBe("event-payload");
    }
  });
});
