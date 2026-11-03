/**
 * @file Wire/peer-event handler FACTORIES (NOT Moku-`emit` hook handlers — `sessionPlugin` subscribes to
 * no Moku event; its inbound signals are the §2 wire + transport peer callbacks). Each factory closes over
 * THIS app's destructured `deps` (D14) and is a thin dispatcher delegating to `lifecycle/*` + `recovery/*`
 * (spec/15 §8 "no domain logic in handlers"). The ONLY `emit` calls here are the owned `room:*` events (via
 * `deps.emit`).
 * @see README.md
 */

import type { Frame, PeerId, RosterEntry } from "../transport/protocol";
import { settleJoin } from "./lifecycle/join";
import { isStarViolation, removeRosterEntry, upsertRosterEntry } from "./lifecycle/roster";
import { drainBuffer, reconcileFlush } from "./recovery/buffer";
import { verifyHostToken } from "./recovery/hosttoken";
import { armReconnectTimeout } from "./recovery/timeout";
import type { SessionDeps, SessionState } from "./types";

/** Closing in the same tick lost `room-full` in real Chromium: 4 of 20 arrived at 0 ms, 20 of 20 from 50 ms. */
const REFUSE_CLOSE_DELAY_MS = 250;

/**
 * Broadcasts the current roster to all controllers via transport's `Wire`. Host-only. Called after every
 * roster mutation so each controller's `session.roster()` mirror stays in sync. Rides a DEDICATED
 * `RosterFrame` — NOT a `sync-snap` — so a roster broadcast never re-baselines (and so wipes) a
 * controller's §4 sync replica on every join/leave (the W3 roster-vs-sync-plane collision).
 *
 * @param deps - This app's destructured per-instance pieces.
 * @example
 * ```ts
 * broadcastRoster(deps); // called after every roster mutation
 * ```
 */
function broadcastRoster(deps: SessionDeps): void {
  const wire = deps.requireTransport().wire();
  wire.broadcast({ t: "roster", roster: deps.state.roster });
}

/**
 * Cancels the pending close of a refused peer. A no-op when none is pending.
 *
 * @param state - This app's session state, which holds the close timers.
 * @param peerId - The peer whose close to cancel.
 * @example
 * ```ts
 * cancelRefuseClose(deps.state, peerId); // the refused peer is back on a new channel
 * ```
 */
function cancelRefuseClose(state: SessionState, peerId: PeerId): void {
  const timer = state._refuseTimers?.get(peerId);
  if (timer === undefined) return;
  clearTimeout(timer);
  state._refuseTimers?.delete(peerId);
}

/**
 * Refuses one peer over the cap: sends `room-full` now and disconnects after {@link REFUSE_CLOSE_DELAY_MS}, so
 * the frame has left before the channel closes. The timer lives in `state` so `teardownSession` can clear it.
 *
 * @param deps - This app's destructured per-instance pieces.
 * @param peerId - The peer to refuse.
 * @example
 * ```ts
 * refusePeer(deps, "p-9");
 * ```
 */
function refusePeer(deps: SessionDeps, peerId: PeerId): void {
  const transport = deps.requireTransport();
  transport.wire().send(peerId, { t: "room-full" });
  const timers = deps.state._refuseTimers ?? new Map<PeerId, ReturnType<typeof setTimeout>>();
  deps.state._refuseTimers = timers;
  timers.set(
    peerId,
    setTimeout(() => {
      timers.delete(peerId);
      transport.disconnect(peerId);
    }, REFUSE_CLOSE_DELAY_MS)
  );
}

/**
 * A controller channel reached `connected` (§6): enforce the cap (`maxControllers`) — tell the 9th
 * `room-full`, then disconnect it after a short delay — otherwise upsert the `RosterEntry`, broadcast the roster, and `emit("room:peer-joined", { peerId })`.
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
    // A refused peer is back on a new channel: the old timer must not close this one.
    cancelRefuseClose(deps.state, peerId);
    const admitted = upsertRosterEntry(deps.state, entry, deps.config.maxControllers);
    if (!admitted) {
      // Room is full: send the reason first, so the refusal is a join result on the phone (§6.2).
      refusePeer(deps, peerId);
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
 * (Controller side) the host channel dropped: enter `recovery.phase = "host-absent"`, arm the
 * `reconnectTimeoutMs` timer (§5.3/§5.4), and emit `room:host-reconnecting`. `intent` hears the event and
 * starts buffering.
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
    deps.emit.hostReconnecting({});
  };
}

/**
 * Whether `peerId` replaces the known host with no absence seen: a different host while the phase is stable means
 * the old one went and the heartbeat has not said so yet. A first join is not one: its `_hostId` can still hold the
 * host of a room this device left.
 *
 * @param state - This app's session state.
 * @param peerId - The peer about to be taken as the host.
 * @returns `true` when the host-absent entry has to run first.
 * @example
 * ```ts
 * if (isSilentHostSwap(deps.state, peerId)) handleHostChannelLost(deps)();
 * ```
 */
function isSilentHostSwap(state: SessionState, peerId: PeerId): boolean {
  const firstJoin = Boolean(state._pendingJoinResolve) && !state._pendingJoinKeepsRoom;
  const differentHost = Boolean(state._hostId) && state._hostId !== peerId;
  return state.recovery.phase === "stable" && differentHost && !firstJoin;
}

/**
 * (Controller side) takes `peerId` as the host. After a silent swap ({@link isSilentHostSwap}) the host-absent
 * entry runs first: `room:host-reconnecting` and `room:host-back` then fire once each, as on any other absence.
 * Ending an absence also cancels the reconnect timer, which would otherwise rejoin behind the host that just came
 * back. A pending join stays pending: a full host opens the channel too, so only its `roster` or `room-full` frame
 * can settle the join.
 *
 * @param deps - This app's destructured per-instance pieces.
 * @param peerId - The peer to take as the host.
 * @example
 * ```ts
 * transport.onPeerConnected(peerId => adoptHost(deps, peerId));
 * ```
 */
export function adoptHost(deps: SessionDeps, peerId: PeerId): void {
  const { state } = deps;
  const { recovery } = state;
  // The old host went unannounced: enter the absence, so it ends below like any other.
  if (isSilentHostSwap(state, peerId)) handleHostChannelLost(deps)();

  // An absence ends here, and its reconnect timer with it: left armed, it would rejoin behind this host.
  const absenceEnds = recovery.phase !== "stable";
  if (recovery.timer !== null) {
    clearTimeout(recovery.timer);
    recovery.timer = null;
  }
  recovery.reconnectDeadline = 0;
  recovery.phase = "stable";
  state.selfId = state.selfId || peerId; // keep our own id if already set
  state._hostId = peerId;
  if (absenceEnds) deps.emit.hostBack({});
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
 * Handles a `roster` frame on the controller: mirrors the host-authoritative roster (§6.1), and the first
 * one admits a pending join. The host and a device with no room ignore it. The frame's arrival is the
 * admission: the host sends `roster` only to devices it admitted, and a refused one gets `room-full`. Its keys
 * cannot prove it: `publicRendezvous` keys the roster by Trystero's peer id, not by this device's `selfId`.
 * Only a host sends `roster`, so one from a peer that is not the known host is the reloaded host, up before
 * the heartbeat saw the old one die: `transport.peers()` still lists the old one, so the connect callback
 * could not tell. Waiting for the heartbeat would lose that callback for good, and stall the phone for
 * `heartbeatTimeoutMs`.
 *
 * @param deps - This app's destructured per-instance pieces.
 * @param peerId - The peer that sent the frame.
 * @param frame - The incoming `roster` frame.
 * @example
 * ```ts
 * handleRoster(deps, peerId, frame);
 * ```
 */
function handleRoster(
  deps: SessionDeps,
  peerId: PeerId,
  frame: Extract<Frame, { t: "roster" }>
): void {
  if (deps.state.role !== "controller") return;
  if (deps.state._hostId && deps.state._hostId !== peerId) adoptHost(deps, peerId);
  deps.state.roster = { ...frame.roster };
  settleJoin(deps, { ok: true, selfId: deps.state.selfId });
}

/**
 * Dispatches the session plugin's inbound `Frame` variants (the single `Wire.on` consumer it registers):
 * `RecoveryHelloFrame` (host verifies the token, replies `RecoveryWelcomeFrame`),
 * `RecoveryWelcomeFrame` (controller verifies the stored token, sends `RecoveryFlushFrame`, moves to
 * `"reconciling"`), `RecoveryFlushFrame` (host applies buffered intents in `cSeq` order, dropping
 * `cSeq <= lastApplied[peerId]` — §4.3 idempotence), `RosterFrame` (controller mirrors the
 * host-authoritative roster — §6.1 — it admits a pending join, and its sender is the host), and `RoomFullFrame` (settles a pending
 * join as `full` — §6.2). Every other frame tag is ignored here (each plugin self-filters).
 *
 * @param deps - This app's destructured per-instance pieces.
 * @returns A function accepting `(peerId, frame)` that dispatches the session-owned frame variants.
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
      case "roster": {
        handleRoster(deps, peerId, frame);
        break;
      }
      case "room-full": {
        settleJoin(deps, { ok: false, reason: "full" });
        break;
      }
      default: {
        // Not a session-owned frame (intent / sync-* / ping / pong) — ignore.
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
