/**
 * @file Wire/peer-event handler FACTORIES (NOT Moku-`emit` hook handlers — `sessionPlugin` subscribes to
 * no Moku event; its inbound signals are the §2 wire + transport peer callbacks). Each factory closes over
 * THIS app's destructured `deps` (D14) and is a thin dispatcher delegating to `lifecycle/*` + `recovery/*`
 * (spec/15 §8 "no domain logic in handlers"). The ONLY `emit` calls here are the three owned `room:*`
 * events (via `deps.emit`).
 * @see README.md
 */

import type { Frame, PeerId, RosterEntry } from "../../contracts";
import { isStarViolation, removeRosterEntry, upsertRosterEntry } from "./lifecycle/roster";
import { drainBuffer, reconcileFlush } from "./recovery/buffer";
import { verifyHostToken } from "./recovery/hosttoken";
import { armReconnectTimeout } from "./recovery/timeout";
import type { SessionDeps } from "./types";

/**
 * Broadcasts the current roster to all controllers via transport's `Wire`. Host-only. Called after every
 * roster mutation so all controllers stay in sync.
 *
 * @param deps - This app's destructured per-instance pieces.
 * @example
 * ```ts
 * broadcastRoster(deps); // called after every roster mutation
 * ```
 */
function broadcastRoster(deps: SessionDeps): void {
  const transport = deps.requireTransport();
  const wire = transport.wire();
  wire.broadcast({
    t: "sync-snap",
    snapshot: {
      roster: deps.state.roster as Record<string, unknown>
    } as import("../../contracts").Snapshot,
    sSeq: deps.state.sSeqAtSnapshot
  });
}

/**
 * A controller channel reached `connected` (§6): enforce the cap (`maxControllers`) — reject the 9th —
 * otherwise upsert the `RosterEntry`, broadcast the roster, and `emit("room:peer-joined", { peerId })`.
 *
 * @param deps - This app's destructured per-instance pieces.
 * @returns A function accepting `(peerId, entry)` that processes the connection event.
 * @example
 * ```ts
 * transport.onPeerConnected(handlePeerConnected(deps));
 * ```
 */
export function handlePeerConnected(
  deps: SessionDeps
): (peerId: PeerId, entry: RosterEntry) => void {
  return (peerId, entry) => {
    const admitted = upsertRosterEntry(deps.state, entry, deps.config.maxControllers);
    if (!admitted) {
      // Room is full — reject by disconnecting the peer immediately.
      const transport = deps.requireTransport();
      transport.disconnect(peerId);
      return;
    }
    // Broadcast updated roster and emit the event.
    broadcastRoster(deps);
    deps.emit.peerJoined({ peerId });
  };
}

/**
 * A controller died (heartbeat, §2.4) or left: remove it from the roster, broadcast the new roster, and
 * `emit("room:peer-left", { peerId })`.
 *
 * @param deps - This app's destructured per-instance pieces.
 * @returns A function accepting `peerId` that processes the disconnection event.
 * @example
 * ```ts
 * transport.onPeerLost(handlePeerLost(deps));
 * ```
 */
export function handlePeerLost(deps: SessionDeps): (peerId: PeerId) => void {
  return peerId => {
    const removed = removeRosterEntry(deps.state, peerId);
    if (removed) {
      broadcastRoster(deps);
      deps.emit.peerLeft({ peerId });
    }
  };
}

/**
 * (Controller side) the host channel dropped: enter `recovery.phase = "host-absent"`, start buffering
 * intents, and arm the `reconnectTimeoutMs` timer (§5.3/§5.4).
 *
 * @param deps - This app's destructured per-instance pieces.
 * @returns A function that processes the host channel loss event.
 * @example
 * ```ts
 * transport.onPeerLost(peerId => { if (peerId === hostId) handleHostChannelLost(deps)(); });
 * ```
 */
export function handleHostChannelLost(deps: SessionDeps): () => void {
  return () => {
    deps.state.recovery.phase = "host-absent";
    armReconnectTimeout(deps);
  };
}

/**
 * Handles a `recovery-hello` frame on the host: verifies the token and replies with
 * `recovery-welcome`. No-op if the role is not `"host"` or the token is invalid.
 *
 * @param deps - This app's destructured per-instance pieces.
 * @param peerId - The controller that sent the hello.
 * @param frame - The incoming `recovery-hello` frame.
 * @example
 * ```ts
 * handleRecoveryHello(deps, peerId, frame);
 * ```
 */
function handleRecoveryHello(
  deps: SessionDeps,
  peerId: PeerId,
  frame: Extract<Frame, { t: "recovery-hello" }>
): void {
  if (deps.state.role !== "host") return;
  if (!verifyHostToken(frame.hostToken, deps.state.hostToken)) return;
  const wire = deps.requireTransport().wire();
  wire.send(peerId, {
    t: "recovery-welcome",
    hostToken: deps.state.hostToken,
    sSeq: deps.state.sSeqAtSnapshot
  });
}

/**
 * Handles a `recovery-welcome` frame on the controller: verifies the token, drains the intent
 * buffer, and sends a `recovery-flush`. No-op if the role is not `"controller"` or token invalid.
 *
 * @param deps - This app's destructured per-instance pieces.
 * @param peerId - The host peer that sent the welcome.
 * @param frame - The incoming `recovery-welcome` frame.
 * @example
 * ```ts
 * handleRecoveryWelcome(deps, peerId, frame);
 * ```
 */
function handleRecoveryWelcome(
  deps: SessionDeps,
  peerId: PeerId,
  frame: Extract<Frame, { t: "recovery-welcome" }>
): void {
  if (deps.state.role !== "controller") return;
  if (!verifyHostToken(frame.hostToken, deps.state.hostToken)) {
    deps.state.recovery.phase = "degraded";
    return;
  }
  deps.state.recovery.phase = "reconciling";
  if (deps.state.recovery.timer !== null) {
    clearTimeout(deps.state.recovery.timer);
    deps.state.recovery.timer = null;
  }
  const buffered = drainBuffer(deps.state, deps.config.intentBufferMaxAgeMs, Date.now());
  const wire = deps.requireTransport().wire();
  wire.send(peerId, { t: "recovery-flush", buffered });
}

/**
 * Handles a `recovery-flush` frame on the host: applies buffered intents in `cSeq` order,
 * dropping any `cSeq <= lastApplied[peerId]` for idempotence (§4.3).
 *
 * @param deps - This app's destructured per-instance pieces.
 * @param peerId - The controller whose buffer is being flushed.
 * @param frame - The incoming `recovery-flush` frame.
 * @param lastApplied - Mutable high-water map shared by the enclosing factory.
 * @example
 * ```ts
 * handleRecoveryFlush(deps, peerId, frame, lastApplied);
 * ```
 */
function handleRecoveryFlush(
  deps: SessionDeps,
  peerId: PeerId,
  frame: Extract<Frame, { t: "recovery-flush" }>,
  lastApplied: Map<PeerId, number>
): void {
  if (deps.state.role !== "host") return;
  const highWater = lastApplied.get(peerId) ?? 0;
  const toApply = reconcileFlush(frame.buffered, peerId, highWater);
  if (toApply.length > 0) {
    const maxSeq = Math.max(...toApply.map(entry => entry.cSeq));
    lastApplied.set(peerId, maxSeq);
    const wire = deps.requireTransport().wire();
    for (const intent of toApply) {
      wire.send(peerId, intent);
    }
  }
}

/**
 * Dispatches inbound recovery `Frame` variants (§5.3): `RecoveryHelloFrame` (host verifies the token,
 * replies `RecoveryWelcomeFrame`, re-broadcasts a fresh snapshot via the `sync` seam),
 * `RecoveryWelcomeFrame` (controller verifies the stored token, sends `RecoveryFlushFrame`, moves to
 * `"reconciling"`), `RecoveryFlushFrame` (host applies buffered intents in `cSeq` order, dropping
 * `cSeq <= lastApplied[peerId]` — §4.3 idempotence). Non-recovery frames are ignored here.
 *
 * @param deps - This app's destructured per-instance pieces.
 * @returns A function accepting `(peerId, frame)` that dispatches recovery frame variants.
 * @example
 * ```ts
 * wire.on(handleRecoveryFrame(deps));
 * ```
 */
export function handleRecoveryFrame(deps: SessionDeps): (peerId: PeerId, frame: Frame) => void {
  // Track the last applied cSeq per controller for idempotent reconcile (§4.3).
  const lastApplied = new Map<PeerId, number>();

  return (peerId, frame) => {
    switch (frame.t) {
      case "recovery-hello": {
        handleRecoveryHello(deps, peerId, frame);
        break;
      }
      case "recovery-welcome": {
        handleRecoveryWelcome(deps, peerId, frame);
        break;
      }
      case "recovery-flush": {
        handleRecoveryFlush(deps, peerId, frame, lastApplied);
        break;
      }
      default: {
        // Non-recovery frame — ignore.
        break;
      }
    }
  };
}

/**
 * Rejects any controller<->controller channel attempt (§6, D11): the host is the only hub. Logs via
 * `ctx.log.warn` (no event — fullness/topology are not connectivity events). DEFENSIVE ONLY — star
 * topology is enforced structurally by transport (passive controllers never offer), so this handler is
 * un-wired in v1 and serves as a defensive fallback.
 *
 * @param deps - This app's destructured per-instance pieces.
 * @returns A function accepting `(from, to)` that rejects star-topology violations.
 * @example
 * ```ts
 * // Un-wired in v1 — defensive helper only.
 * handleStarTopologyViolation(deps)(from, to);
 * ```
 */
export function handleStarTopologyViolation(deps: SessionDeps): (from: PeerId, to: PeerId) => void {
  return (from, to) => {
    if (isStarViolation(from, to, deps.state.selfId, deps.state.role)) {
      // Log the rejection via the injected ctx.log surface. No event (fullness/topology are not
      // connectivity events — spec/15 §8).
      deps.log.warn(
        `[room] Star-topology violation rejected: ${from} -> ${to}. The host is the only hub.`
      );
    }
  };
}
