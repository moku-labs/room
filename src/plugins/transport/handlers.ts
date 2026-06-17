/**
 * @file Signaling-glue handlers — bridge a live `SignalingSession` to the per-peer `RTCPeerConnection`s.
 * @see README.md
 *
 * These are the offer/answer/ICE glue functions wired by `connect()` onto `session.onPeer` /
 * `session.onSignal` / `session.onPeerLeave`. They apply each inbound `SignalMsg` to the matching peer
 * connection (setRemoteDescription / addIceCandidate / createAnswer) and trickle local descriptions back
 * over the signaling plane. They do NOT emit Moku events — `onPeerLeave` during a handshake is
 * bookkeeping-only (dead-peer detection for ESTABLISHED channels is the heartbeat's job, section 2.4).
 */
import type { PeerId, SignalMsg } from "../../contracts";
import type { TransportConfig, TransportState } from "./types";

/**
 * Handles a newly-present signaling peer. For the host (active offerer) this creates an
 * `RTCPeerConnection` + DataChannel for `peerId` and sends an offer; for a controller (passive) it is a
 * no-op until the host offers. Arms the open-timeout timer for the new channel.
 *
 * @param state - The per-app transport state holding the peer map and signaling session.
 * @param cfg - The transport config (ICE servers, open timeout).
 * @param peerId - The peer that just appeared in the signaling room.
 * @throws {Error} Always — skeleton stub.
 * @example
 * ```ts
 * handlePeerArrival(state, cfg, "p_ab12");
 * ```
 */
export function handlePeerArrival(
  state: TransportState,
  cfg: TransportConfig,
  peerId: PeerId
): void {
  throw new Error("not implemented");
}

/**
 * Applies one inbound `SignalMsg` to the matching `RTCPeerConnection`: an `offer` triggers an `answer`
 * back over the signaling plane; an `answer` is set as the remote description; a `candidate` is added
 * via `addIceCandidate`. Stays joined until `iceConnectionState` is `connected`/`completed`, then leaves
 * the session (contracts section 1.2 trickle-ICE rule).
 *
 * @param state - The per-app transport state holding the peer map and signaling session.
 * @param cfg - The transport config (ICE servers).
 * @param peerId - The sender of the handshake message.
 * @param msg - The inbound offer/answer/candidate (contracts section 1.1).
 * @throws {Error} Always — skeleton stub.
 * @example
 * ```ts
 * handleSignal(state, cfg, "p_ab12", { kind: "offer", sdp });
 * ```
 */
export function handleSignal(
  state: TransportState,
  cfg: TransportConfig,
  peerId: PeerId,
  msg: SignalMsg
): void {
  throw new Error("not implemented");
}

/**
 * Handles a peer disappearing from the signaling room DURING the handshake. Bookkeeping-only — clears the
 * half-open peer's timers and removes its record if it never reached `connected`. Does NOT emit
 * `room:peer-left` (that is `sessionPlugin`'s job, driven by the heartbeat — contracts section 2.4).
 *
 * @param state - The per-app transport state holding the peer map.
 * @param peerId - The peer that left the signaling room.
 * @throws {Error} Always — skeleton stub.
 * @example
 * ```ts
 * handlePeerLeave(state, "p_ab12");
 * ```
 */
export function handlePeerLeave(state: TransportState, peerId: PeerId): void {
  throw new Error("not implemented");
}
