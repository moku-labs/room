/**
 * @file Signaling-glue handlers — bridge a live `SignalingSession` to the per-peer `RTCPeerConnection`s.
 * @see README.md
 *
 * These are the offer/answer/ICE glue functions wired by `connect()` onto `session.onPeer` /
 * `session.onSignal` / `session.onPeerLeave`. They apply each inbound `SignalMsg` to the matching peer
 * connection (setRemoteDescription / addIceCandidate / createAnswer) and trickle local descriptions back
 * over the signaling plane. They do NOT emit Moku events — `onPeerLeave` during a handshake is
 * bookkeeping-only (dead-peer detection for ESTABLISHED channels is the heartbeat's job, section 2.4).
 *
 * The `inMemory` adapter exposes a loopback capability (`openWireChannel`); when present, a peer is wired
 * directly to its in-process channel and marked `connected` with no `RTCPeerConnection`. Real adapters
 * lack it and the full WebRTC handshake runs.
 */
import type { IceCandidateInit, PeerId, RoomEvents, SignalMsg } from "../../contracts";
import type { LoopbackSignaling, WireChannel } from "./channel";
import { bindPeerChannel } from "./channel";
import type { PeerConnection, TransportConfig, TransportState } from "./types";

/** The narrowed `room:network-warning` reason emitter the wiring harness binds (api.ts). */
type EmitWarning = (reason: RoomEvents["room:network-warning"]["reason"]) => void;

/**
 * Maximum open-timeout handshake retries before transport gives up on a peer, emits
 * `room:network-warning { reason: "ice-failed" }`, and stops. Caps the iOS-Safari to Sony-Bravia
 * mitigation so a permanently-unreachable peer cannot drive an infinite offer/answer loop.
 */
const MAX_OPEN_RETRIES = 3;

/**
 * Detects the transport-internal loopback capability on a signaling session. Returns the session cast
 * as a `LoopbackSignaling` if it exposes `openWireChannel` (the `inMemory` adapter), or `null` for
 * real adapters that fall back to the WebRTC handshake.
 *
 * @param session - The current signaling session, or `null` if not yet joined.
 * @returns The session as a `LoopbackSignaling` if the loopback capability is present; otherwise `null`.
 * @example
 * ```ts
 * const loopback = asLoopback(state.session);
 * if (loopback) { const ch = loopback.openWireChannel(peerId); }
 * ```
 */
function asLoopback(session: TransportState["session"]): LoopbackSignaling | null {
  if (session && typeof (session as Partial<LoopbackSignaling>).openWireChannel === "function") {
    return session as unknown as LoopbackSignaling;
  }
  return null;
}

/**
 * Mints a fresh `RTCPeerConnection` for `peerId`, stores a new `"connecting"` peer record in
 * `state.peers`, and wires the ICE candidate trickle and connection-state callbacks. The ICE callback
 * sends each candidate over the signaling plane; the state callback marks the peer `"connected"` and
 * schedules a signaling `leave()` once the channel is up (contracts section 1.2).
 *
 * @param state - The per-app transport state holding the peer map and signaling session.
 * @param cfg - The transport config (ICE servers).
 * @param peerId - The peer id to create the connection for.
 * @returns The newly-created and registered `PeerConnection` record.
 * @example
 * ```ts
 * const peer = createPeer(state, cfg, "p_ab12");
 * ```
 */
function createPeer(state: TransportState, cfg: TransportConfig, peerId: PeerId): PeerConnection {
  const pc = new RTCPeerConnection({ iceServers: [...cfg.iceServers] });
  const peer: PeerConnection = {
    peerId,
    pc,
    channel: null,
    state: "connecting",
    lastPongAt: Date.now(),
    paused: false,
    reassembly: new Map(),
    openTimer: null,
    retries: 0
  };
  state.peers.set(peerId, peer);

  /**
   * Trickles each local ICE candidate to the remote peer over the signaling plane.
   *
   * @param event - The RTCPeerConnectionIceEvent carrying the new local candidate.
   * @example
   * ```ts
   * pc.onicecandidate = handler;
   * ```
   */
  pc.onicecandidate = (event): void => {
    if (event.candidate && state.session) {
      const candidate: IceCandidateInit = {
        candidate: event.candidate.candidate,
        sdpMid: event.candidate.sdpMid,
        sdpMLineIndex: event.candidate.sdpMLineIndex,
        usernameFragment: event.candidate.usernameFragment
      };
      state.session.send(peerId, { kind: "candidate", candidate });
    }
  };

  /**
   * Marks the peer `"connected"` and clears the open-timeout timer when ICE reaches
   * connected/completed — the cue that the WebRTC handshake for this peer succeeded. On a transient
   * `disconnected` blip it calls `pc.restartIce()` so the connection recovers in place rather than
   * waiting for the heartbeat to tear it down (contracts section §restartIce).
   *
   * @example
   * ```ts
   * pc.oniceconnectionstatechange?.(new Event("iceconnectionstatechange"));
   * ```
   */
  pc.oniceconnectionstatechange = (): void => {
    const live = pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed";
    if (live) {
      peer.state = "connected";
      peer.lastPongAt = Date.now();
      if (peer.openTimer !== null) {
        clearTimeout(peer.openTimer);
        peer.openTimer = null;
      }
      state.session
        ?.leave()
        .then(() => {
          if (state.session) state.session = null;
        })
        .catch(() => {
          // leave() failure is non-fatal: signaling is best-effort post-ICE (contracts section 1.2)
        });
    } else if (pc.iceConnectionState === "disconnected") {
      // Transient ICE blip: ask the agent to re-gather rather than waiting for heartbeat teardown.
      pc.restartIce();
    }
  };
  return peer;
}

/**
 * Attaches an opened `WireChannel` to the peer record and wires its receive pump so inbound frames
 * start flowing to the `Wire.on` consumer. Called immediately after the DataChannel or loopback pipe
 * is confirmed open (both real WebRTC and the in-memory loopback path use this same entry point).
 *
 * @param state - The per-app transport state (peer map, frame consumer).
 * @param peer - The peer record that will receive the channel assignment.
 * @param channel - The open channel to attach (real `RTCDataChannel` or loopback `WireChannel`).
 * @example
 * ```ts
 * bindChannel(state, peer, dataChannel as unknown as WireChannel);
 * ```
 */
function bindChannel(state: TransportState, peer: PeerConnection, channel: WireChannel): void {
  peer.channel = channel as unknown as PeerConnection["channel"];
  bindPeerChannel(state, peer);
}

/**
 * Handles a newly-present signaling peer. For the host (active offerer) this creates an
 * `RTCPeerConnection` + DataChannel for `peerId` and sends an offer; for a controller (passive) it is a
 * no-op until the host offers. Arms the open-timeout timer for the new channel. Over a loopback session
 * (`inMemory`) it wires the in-process channel directly and marks the peer connected.
 *
 * On a re-entry from {@link retryHandshake}, `retries` carries the running attempt count across the
 * peer's delete + recreate, so the open-timeout retry stays capped at {@link MAX_OPEN_RETRIES}.
 *
 * @param state - The per-app transport state holding the peer map and signaling session.
 * @param cfg - The transport config (ICE servers, open timeout).
 * @param peerId - The peer that just appeared in the signaling room.
 * @param emitWarning - Narrowed `room:network-warning` emitter; fired with `ice-failed` once retries exhaust.
 * @param retries - Open-timeout retries already spent for this peer (re-entry from the retry timer). Default `0`.
 * @example
 * ```ts
 * handlePeerArrival(state, cfg, "p_ab12", reason => ctx.emit("room:network-warning", { reason }));
 * ```
 */
export function handlePeerArrival(
  state: TransportState,
  cfg: TransportConfig,
  peerId: PeerId,
  emitWarning: EmitWarning,
  retries = 0
): void {
  const loopback = asLoopback(state.session);
  // Loopback (inMemory) path: wire the in-process channel directly and mark the peer connected.
  if (loopback) {
    if (state.peers.has(peerId)) return;
    const channel = loopback.openWireChannel(peerId);
    if (!channel) return;
    const peer: PeerConnection = {
      peerId,
      // eslint-disable-next-line jsdoc/require-jsdoc -- inert close() on the loopback peer's fake RTCPeerConnection (no real pc to tear down)
      pc: { close() {} } as unknown as RTCPeerConnection,
      channel: null,
      state: "connected",
      lastPongAt: Date.now(),
      paused: false,
      reassembly: new Map(),
      openTimer: null,
      retries
    };
    state.peers.set(peerId, peer);
    bindChannel(state, peer, channel);
    state.peerConnectedCb?.(peerId);
    return;
  }

  // Real WebRTC path: only the active host offers on peer arrival.
  if (state.role !== "host") return;
  const peer = createPeer(state, cfg, peerId);
  peer.retries = retries;
  const channel = peer.pc.createDataChannel("room", { ordered: true });
  channel.addEventListener("open", () => {
    if (peer.openTimer !== null) {
      clearTimeout(peer.openTimer);
      peer.openTimer = null;
    }
    state.peerConnectedCb?.(peerId);
  });
  bindChannel(state, peer, channel as unknown as WireChannel);
  peer.openTimer = setTimeout(
    () => retryHandshake(state, cfg, peerId, emitWarning),
    cfg.openTimeoutMs
  );

  (async (): Promise<void> => {
    const offer = await peer.pc.createOffer();
    await peer.pc.setLocalDescription(offer);
    state.session?.send(peerId, { kind: "offer", sdp: offer.sdp ?? "" });
  })().catch(() => {
    // offer creation failure is non-fatal; the open-timeout retry will reattempt the handshake
  });
}

/**
 * Tears down a half-open peer and re-initiates the handshake over the same signaling session, capped at
 * {@link MAX_OPEN_RETRIES}. Called by the open-timeout timer when a DataChannel does not reach `open`
 * within `cfg.openTimeoutMs`. Closes the stale `RTCPeerConnection` and removes the peer record, then:
 * within the cap, re-enters {@link handlePeerArrival} (carrying the incremented attempt count) for a
 * fresh offer/answer exchange; past the cap, emits `room:network-warning { reason: "ice-failed" }` once
 * (de-duped via `state.warned`, key `ice-failed:${peerId}`) and STOPS — no further timer is armed, so a
 * permanently-unreachable peer cannot loop forever (the iOS-to-Bravia GATE mitigation).
 *
 * @param state - The per-app transport state holding the peer map and signaling session.
 * @param cfg - The transport config (open timeout, ICE servers).
 * @param peerId - The peer whose handshake timed out.
 * @param emitWarning - Narrowed `room:network-warning` emitter; fired with `ice-failed` once on exhaustion.
 * @example
 * ```ts
 * peer.openTimer = setTimeout(() => retryHandshake(state, cfg, peerId, emitWarning), cfg.openTimeoutMs);
 * ```
 */
function retryHandshake(
  state: TransportState,
  cfg: TransportConfig,
  peerId: PeerId,
  emitWarning: EmitWarning
): void {
  const peer = state.peers.get(peerId);
  if (!peer || peer.state === "connected") return;
  const next = peer.retries + 1;
  peer.state = "retrying";
  peer.pc.close();
  state.peers.delete(peerId);
  if (next > MAX_OPEN_RETRIES) {
    const key = `ice-failed:${peerId}`;
    if (!state.warned.has(key)) {
      state.warned.add(key);
      emitWarning("ice-failed");
    }
    return;
  }
  handlePeerArrival(state, cfg, peerId, emitWarning, next);
}

/**
 * Applies one inbound `SignalMsg` to the matching `RTCPeerConnection`: an `offer` triggers an `answer`
 * back over the signaling plane; an `answer` is set as the remote description; a `candidate` is added via
 * `addIceCandidate`. Stays joined until `iceConnectionState` is `connected`/`completed`, then leaves the
 * session (contracts section 1.2 trickle-ICE rule). A no-op over a loopback session (no SDP to apply).
 *
 * @param state - The per-app transport state holding the peer map and signaling session.
 * @param cfg - The transport config (ICE servers).
 * @param peerId - The sender of the handshake message.
 * @param msg - The inbound offer/answer/candidate (contracts section 1.1).
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
  if (asLoopback(state.session)) return;
  if (msg.kind === "candidate") {
    state.peers
      .get(peerId)
      ?.pc.addIceCandidate(msg.candidate)
      .catch(() => {
        // addIceCandidate failure is non-fatal; trickle-ICE may deliver candidates out of order
      });
    return;
  }
  if (msg.kind === "answer") {
    state.peers
      .get(peerId)
      ?.pc.setRemoteDescription({ type: "answer", sdp: msg.sdp })
      .catch(() => {
        // setRemoteDescription failure is non-fatal; the open-timeout retry handles recovery
      });
    return;
  }
  // msg.kind === "offer" — apply it and answer back.
  const sdp = msg.sdp;
  (async (): Promise<void> => {
    const peer = state.peers.get(peerId) ?? createAnswerer(state, cfg, peerId);
    await peer.pc.setRemoteDescription({ type: "offer", sdp });
    const answer = await peer.pc.createAnswer();
    await peer.pc.setLocalDescription(answer);
    state.session?.send(peerId, { kind: "answer", sdp: answer.sdp ?? "" });
  })().catch(() => {
    // answer creation failure is non-fatal; the open-timeout retry handles recovery
  });
}

/**
 * Creates a passive answerer peer for the controller side: mints the `RTCPeerConnection`, wires the
 * `ondatachannel` callback that binds the host-offered DataChannel once it arrives, and arms the
 * open-timeout guard. The `RTCPeerConnection` is created before the remote description so it is ready
 * to accept the offer and negotiate ICE.
 *
 * @param state - The per-app transport state holding the peer map.
 * @param cfg - The transport config (ICE servers, open timeout).
 * @param peerId - The host peer id this answerer will connect to.
 * @returns The newly-created `PeerConnection` record in `"connecting"` state.
 * @example
 * ```ts
 * const peer = createAnswerer(state, cfg, "host_root");
 * ```
 */
function createAnswerer(
  state: TransportState,
  cfg: TransportConfig,
  peerId: PeerId
): PeerConnection {
  const peer = createPeer(state, cfg, peerId);
  /**
   * Receives the host-offered DataChannel, clears the open timer on `open`, and binds the receive pump.
   *
   * @param event - The `RTCDataChannelEvent` carrying the freshly-negotiated channel.
   * @example
   * ```ts
   * peer.pc.ondatachannel?.(new RTCDataChannelEvent("datachannel", { channel }));
   * ```
   */
  peer.pc.ondatachannel = (event): void => {
    event.channel.addEventListener("open", () => {
      if (peer.openTimer !== null) {
        clearTimeout(peer.openTimer);
        peer.openTimer = null;
      }
      state.peerConnectedCb?.(peerId);
    });
    bindChannel(state, peer, event.channel as unknown as WireChannel);
  };
  peer.openTimer = setTimeout(() => {
    if (peer.state !== "connected" && peer.openTimer !== null) peer.openTimer = null;
  }, cfg.openTimeoutMs);
  return peer;
}

/**
 * Handles a peer disappearing from the signaling room DURING the handshake. Bookkeeping-only — clears the
 * half-open peer's open timer and removes its record if it never reached `connected`. Does NOT emit
 * `room:peer-left` (that is `sessionPlugin`'s job, driven by the heartbeat — contracts section 2.4).
 *
 * @param state - The per-app transport state holding the peer map.
 * @param peerId - The peer that left the signaling room.
 * @example
 * ```ts
 * handlePeerLeave(state, "p_ab12");
 * ```
 */
export function handlePeerLeave(state: TransportState, peerId: PeerId): void {
  const peer = state.peers.get(peerId);
  if (!peer || peer.state === "connected") return;
  if (peer.openTimer !== null) clearTimeout(peer.openTimer);
  peer.pc.close();
  state.peers.delete(peerId);
}
