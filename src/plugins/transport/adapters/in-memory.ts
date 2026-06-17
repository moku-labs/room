/**
 * @file The `inMemory` signaling adapter — a deterministic in-process bus for tests (D12). DOM-free; no
 * `RTCPeerConnection`. Two sessions on the same `code` mutually fire `onPeer` and deliver `SignalMsg`s
 * in-process. Pulls in ZERO Trystero.
 * @see ../README.md
 *
 * Beyond the `Signaling` contract, an in-memory session also exposes a transport-internal **loopback**
 * capability (`LoopbackSignaling`): on pairing it can hand transport an already-open in-process
 * `WireChannel` pair so the integration tests carry real `Frame`s end-to-end without any
 * `RTCPeerConnection`. Real adapters omit this capability and transport falls back to the WebRTC
 * handshake. A module-level registry keyed by `code` pairs sessions — an intentional process-global
 * test/dev bus, distinct from per-app plugin state (D14 governs plugin state, not this adapter bus).
 */
import type { Signaling, SignalingJoinOpts, SignalMsg } from "../../../contracts";
import type { LoopbackEndpoint, LoopbackSignaling } from "../channel";

/** A live participant on the in-process bus — one per `join` call. */
type Member = {
  readonly selfId: string;
  onPeer: ((peerId: string) => void) | null;
  onPeerLeave: ((peerId: string) => void) | null;
  onSignal: ((peerId: string, msg: SignalMsg) => void) | null;
  /** Peers present at registration time but not yet delivered to a (late) `onPeer` callback. */
  readonly pendingPeers: string[];
  /** Open loopback wire endpoints keyed by the remote peer id (the in-process DataChannel pair). */
  readonly channels: Map<string, LoopbackEndpoint>;
};

/** A room on the bus — the set of members sharing one `code`. */
type Room = {
  readonly members: Map<string, Member>;
};

/**
 * One end of an in-process wire pipe. `send` pushes into the paired endpoint's `onmessage` on a
 * microtask (mirroring a real channel's async delivery); `bufferedAmount` stays `0` (no real socket) so
 * backpressure never engages on the test bus.
 */
class PipeEndpoint implements LoopbackEndpoint {
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  readyState: "open" | "closed" = "open";
  onmessage: ((event: { data: string }) => void) | null = null;
  peer: PipeEndpoint | null = null;
  private closeHandler: (() => void) | null = null;

  /* eslint-disable jsdoc/require-jsdoc -- in-process DataChannel shim; mirrors the lib.dom RTCDataChannel methods consumed by channel.ts */
  send(data: string): void {
    const target = this.peer;
    if (this.readyState !== "open" || target?.readyState !== "open") return;
    queueMicrotask(() => target.onmessage?.({ data }));
  }

  addEventListener(type: string, cb: () => void): void {
    if (type === "close") this.closeHandler = cb;
  }

  removeEventListener(type: string): void {
    if (type === "close") this.closeHandler = null;
  }

  close(): void {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.closeHandler?.();
  }
  /* eslint-enable jsdoc/require-jsdoc */
}

/**
 * Delivers a peer arrival to `member` now if its `onPeer` is registered, else queues it on
 * `pendingPeers` so a later `onPeer` registration drains it (handles join-order races on the bus).
 *
 * @param member - The bus member to notify of the new peer.
 * @param peerId - The id of the peer that just joined the same `code`.
 * @example
 * ```ts
 * notifyPeer(hostMember, "p_ab12");
 * ```
 */
function notifyPeer(member: Member, peerId: string): void {
  if (member.onPeer) member.onPeer(peerId);
  else member.pendingPeers.push(peerId);
}

/**
 * Creates an in-process `Signaling` adapter (contracts section 1). Sessions joined on the same `code`
 * share one in-memory bus: each fires the other's `onPeer`, and `send` delivers `SignalMsg`s to the
 * recipient's `onSignal`. On pairing it also opens an in-process `WireChannel` pair (the loopback
 * capability) so transport carries real frames end-to-end with no `RTCPeerConnection`. `leave()` is
 * idempotent. Used by `tests/integration/` for a deterministic transport (the DOM-free proof, D12).
 *
 * @returns A `Signaling` adapter backed by an in-process, per-`code` bus.
 * @example
 * ```ts
 * const sig = inMemory();
 * const host = await sig.join("K7M2QX", { selfId: "host_root" });
 * const ctrl = await sig.join("K7M2QX", { selfId: "p_ab12", passive: true });
 * ```
 */
export function inMemory(): Signaling {
  const rooms = new Map<string, Room>();

  /**
   * Joins the in-process bus for `code`, opening a loopback pipe with every existing member and
   * announcing self to them. Returns a {@link SignalingSessionImpl} (the contract plus the loopback
   * `openWireChannel` capability the integration tests use to carry real frames with no WebRTC).
   *
   * @param code - The room code whose in-memory bus to join.
   * @param opts - Self id + role (the bus has no offer/answer asymmetry, so `passive` is ignored).
   * @returns The live in-process signaling session.
   * @example
   * ```ts
   * const session = await inMemory().join("K7M2QX", { selfId: "host_root" });
   * ```
   */
  const join = async (code: string, opts: SignalingJoinOpts): Promise<SignalingSessionImpl> => {
    const room = rooms.get(code) ?? { members: new Map<string, Member>() };
    rooms.set(code, room);

    const self: Member = {
      selfId: opts.selfId,
      onPeer: null,
      onPeerLeave: null,
      onSignal: null,
      pendingPeers: [],
      channels: new Map()
    };

    /**
     * Opens a paired loopback channel between `self` and member `peerId` (idempotent — once per pair).
     *
     * @param peerId - The already-present member to open an in-process wire pipe with.
     * @example
     * ```ts
     * ensurePipe("host_root");
     * ```
     */
    const ensurePipe = (peerId: string): void => {
      const other = room.members.get(peerId);
      if (!other || self.channels.has(peerId)) return;
      const a = new PipeEndpoint();
      const b = new PipeEndpoint();
      a.peer = b;
      b.peer = a;
      self.channels.set(peerId, a);
      other.channels.set(self.selfId, b);
    };

    // Open a pipe with every existing member, queue self's notification, and notify each of them now.
    const existing = [...room.members.values()];
    room.members.set(self.selfId, self);
    for (const other of existing) {
      ensurePipe(other.selfId);
      self.pendingPeers.push(other.selfId);
      notifyPeer(other, self.selfId);
    }

    /* eslint-disable jsdoc/require-jsdoc -- structural SignalingSession + loopback wiring; method semantics live on the contract (contracts.ts §1) and channel.ts LoopbackSignaling */
    const session: SignalingSessionImpl = {
      onPeer(cb) {
        self.onPeer = cb;
        const queued = self.pendingPeers.splice(0);
        for (const peerId of queued) cb(peerId);
      },
      onPeerLeave(cb) {
        self.onPeerLeave = cb;
      },
      onSignal(cb) {
        self.onSignal = cb;
      },
      send(peerId, msg) {
        room.members.get(peerId)?.onSignal?.(self.selfId, msg);
      },
      async leave() {
        if (!room.members.has(self.selfId)) return;
        room.members.delete(self.selfId);
        for (const [peerId, endpoint] of self.channels) {
          endpoint.close();
          const other = room.members.get(peerId);
          other?.channels.delete(self.selfId);
          other?.onPeerLeave?.(self.selfId);
        }
        self.channels.clear();
        if (room.members.size === 0) rooms.delete(code);
      },
      openWireChannel(peerId) {
        ensurePipe(peerId);
        return self.channels.get(peerId) ?? null;
      }
    };
    /* eslint-enable jsdoc/require-jsdoc */
    return session;
  };

  return { join };
}

/** The in-memory session shape: the `Signaling` contract plus the loopback capability. */
type SignalingSessionImpl = LoopbackSignaling & {
  onPeer(cb: (peerId: string) => void): void;
  onPeerLeave(cb: (peerId: string) => void): void;
  onSignal(cb: (peerId: string, msg: SignalMsg) => void): void;
  send(peerId: string, msg: SignalMsg): void;
  leave(): Promise<void>;
};
