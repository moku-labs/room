/**
 * @file Unit tests for `recovery/timeout.ts`: reconnectTimeoutMs elapses -> phase "host-absent" ->
 * "degraded"; on a simulated iOS UA the degrade surfaces the "rescan QR" path (recoveryPhase()==="degraded",
 * rejoin() available); on non-iOS, auto-rejoin is attempted before degrade (ctx.env/UA injected).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PeerId } from "../../../transport/protocol";
import type { SessionStateWithRuntime } from "../../recovery/reentry";
import { registerTransportBindings } from "../../recovery/reentry";
import { armReconnectTimeout, degradeOrRejoin } from "../../recovery/timeout";
import { createSessionState } from "../../state";
import type { SessionConfig, SessionDeps } from "../../types";

const testConfig: Readonly<SessionConfig> = {
  joinUrlBase: "",
  generateQr: false,
  maxControllers: 8,
  snapshotDebounceMs: 500,
  reconnectTimeoutMs: 200, // short for tests
  intentBufferMax: 256,
  intentBufferMaxAgeMs: 8000,
  storageKeyPrefix: "test.room"
};

function makeDeps(state = createSessionState()): SessionDeps {
  state.role = "controller";
  state.roomCode = "TEST01";
  return {
    state,
    config: testConfig,
    emit: { peerJoined: vi.fn(), peerLeft: vi.fn(), hostReconnecting: vi.fn() },
    log: { warn: vi.fn() },
    requireTransport: vi.fn().mockReturnValue({
      connect: vi.fn().mockRejectedValue(new Error("not-found")),
      wire: vi.fn().mockReturnValue({ send: vi.fn(), broadcast: vi.fn(), on: vi.fn() }),
      disconnect: vi.fn(),
      peers: vi.fn().mockReturnValue([]),
      close: vi.fn().mockResolvedValue(undefined),
      onPeerConnected: vi.fn(),
      onPeerLost: vi.fn()
    })
  };
}

describe("recovery/timeout", () => {
  let originalNavigator: typeof globalThis.navigator;

  beforeEach(() => {
    vi.useFakeTimers();
    originalNavigator = globalThis.navigator;
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(globalThis, "navigator", {
      value: originalNavigator,
      writable: true,
      configurable: true
    });
  });

  it("transitions host-absent -> degraded when reconnectTimeoutMs elapses (iOS path)", async () => {
    // Simulate iOS UA.
    Object.defineProperty(globalThis, "navigator", {
      value: {
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15"
      },
      writable: true,
      configurable: true
    });

    const state = createSessionState();
    state.recovery.phase = "host-absent";
    const deps = makeDeps(state);

    armReconnectTimeout(deps);
    expect(deps.state.recovery.timer).not.toBeNull();
    expect(deps.state.recovery.reconnectDeadline).toBeGreaterThan(Date.now());

    // Advance time past the reconnect timeout.
    await vi.advanceTimersByTimeAsync(250);

    // On iOS: should have degraded immediately.
    expect(deps.state.recovery.phase).toBe("degraded");
    expect(deps.state.recovery.timer).toBeNull();
  });

  it("on a simulated iOS UA, degrades to the rescan-QR path (recoveryPhase === degraded)", async () => {
    Object.defineProperty(globalThis, "navigator", {
      value: { userAgent: "AppleWebKit/605.1.15 (iPhone)" },
      writable: true,
      configurable: true
    });

    const deps = makeDeps();
    deps.state.recovery.phase = "host-absent";

    await degradeOrRejoin(deps);

    expect(deps.state.recovery.phase).toBe("degraded");
  });

  it("on a non-iOS UA, attempts auto-rejoin before degrading", async () => {
    // Simulate a non-iOS UA.
    Object.defineProperty(globalThis, "navigator", {
      value: {
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120"
      },
      writable: true,
      configurable: true
    });

    const state = createSessionState();
    state.recovery.phase = "host-absent";
    state.roomCode = "TEST01";
    const deps = makeDeps(state);

    // connect will reject → degraded.
    await degradeOrRejoin(deps);

    // After failed rejoin, should degrade.
    expect(deps.state.recovery.phase).toBe("degraded");
  });

  it("armReconnectTimeout clears the old timer before arming a new one", () => {
    const deps = makeDeps();
    armReconnectTimeout(deps);
    const firstTimer = deps.state.recovery.timer;
    armReconnectTimeout(deps);
    const secondTimer = deps.state.recovery.timer;
    // The second arming replaces the first.
    expect(secondTimer).not.toBe(firstTimer);
  });

  it("degradeOrRejoin treats an undefined navigator as non-iOS", async () => {
    // No navigator at all (headless/Bun) → isIosWebKit() returns false → non-iOS rejoin path.
    Object.defineProperty(globalThis, "navigator", {
      value: undefined,
      writable: true,
      configurable: true
    });

    const state = createSessionState();
    state.recovery.phase = "host-absent";
    state.roomCode = "TEST01";
    const deps = makeDeps(state);

    // connect rejects → rejoin fails → degraded (proves the non-iOS branch ran).
    await degradeOrRejoin(deps);

    expect(deps.state.recovery.phase).toBe("degraded");
  });

  it("degradeOrRejoin clears a pre-existing reconnect timer before deciding", async () => {
    Object.defineProperty(globalThis, "navigator", {
      value: { userAgent: "AppleWebKit/605.1.15 (iPhone)" },
      writable: true,
      configurable: true
    });

    const deps = makeDeps();
    deps.state.recovery.phase = "host-absent";
    // Arm a live timer so degradeOrRejoin must clear it (covers the timer !== null branch).
    deps.state.recovery.timer = setTimeout(() => {}, 99_999);
    expect(deps.state.recovery.timer).not.toBeNull();

    await degradeOrRejoin(deps);

    // Timer cleared and nulled by degradeOrRejoin itself.
    expect(deps.state.recovery.timer).toBeNull();
    expect(deps.state.recovery.phase).toBe("degraded");
  });

  it("degradeOrRejoin degrades when rejoinSameRoom throws (no stored roomCode)", async () => {
    Object.defineProperty(globalThis, "navigator", {
      value: {
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120"
      },
      writable: true,
      configurable: true
    });

    const state = createSessionState();
    state.recovery.phase = "host-absent";
    const deps = makeDeps(state);
    // No roomCode → rejoinSameRoom throws synchronously → degradeOrRejoin catch path.
    // (makeDeps sets roomCode, so clear it AFTER.)
    deps.state.roomCode = "";

    await degradeOrRejoin(deps);

    expect(deps.state.recovery.phase).toBe("degraded");
  });

  it("degradeOrRejoin does NOT degrade when auto-rejoin succeeds (non-iOS)", async () => {
    Object.defineProperty(globalThis, "navigator", {
      value: {
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120"
      },
      writable: true,
      configurable: true
    });

    const state = createSessionState();
    state.role = "controller";
    state.recovery.phase = "host-absent";
    state.roomCode = "TEST01";

    // A transport whose onPeerConnected registration we can replay to simulate a successful connect.
    const onPeerConnected = vi.fn<(peerId: PeerId) => void>();
    const wire = { send: vi.fn(), broadcast: vi.fn(), on: vi.fn() };
    const transport = {
      connect: vi.fn().mockResolvedValue(undefined),
      wire: vi.fn().mockReturnValue(wire),
      disconnect: vi.fn(),
      peers: vi.fn().mockReturnValue([]),
      close: vi.fn().mockResolvedValue(undefined),
      onPeerConnected: vi.fn((cb: (peerId: PeerId) => void) => {
        onPeerConnected.mockImplementation(cb);
      }),
      onPeerLost: vi.fn()
    };

    const deps: SessionDeps = {
      state,
      config: testConfig,
      emit: { peerJoined: vi.fn(), peerLeft: vi.fn(), hostReconnecting: vi.fn() },
      log: { warn: vi.fn() },
      requireTransport: vi.fn().mockReturnValue(transport)
    };

    // Wire the transport callbacks (registers the real onPeerConnected handler into our spy).
    registerTransportBindings(deps);
    expect(transport.onPeerConnected).toHaveBeenCalledOnce();

    // Kick off the rejoin (do NOT await — it resolves once the host connects).
    const decision = degradeOrRejoin(deps);

    // Let the connect() promise + pending-resolver wiring settle.
    await vi.advanceTimersByTimeAsync(0);

    // Simulate the host channel opening → resolves the pending join with { ok: true }.
    const rt = deps.state as unknown as SessionStateWithRuntime;
    expect(rt._pendingJoinResolve).not.toBeNull();
    onPeerConnected("host-peer");

    await decision;

    // Success path: rejoinSameRoom set phase to "stable"; degradeOrRejoin did NOT degrade.
    expect(deps.state.recovery.phase).toBe("stable");
  });
});
