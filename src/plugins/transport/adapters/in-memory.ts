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
  /** `true` for a passive (controller) join — two passive members never pipe to each other (star). */
  readonly passive: boolean;
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
 * One end of an in-process wire pipe. `send` hands the message to the paired endpoint, which delivers it
 * on a microtask (mirroring a real channel's async delivery) once its `onmessage` sink is bound — and
 * BUFFERS it until then. `bufferedAmount` stays `0` (no real socket) so backpressure never engages.
 *
 * The buffer matters for late joiners: the host pushes its join-baseline `sync-snap` the instant the peer
 * connects (on `room:peer-joined`), but the joiner wires its receive pump one microtask LATER (transport's
 * `handlePeerArrival` → `bindChannel`). A real `RTCDataChannel` binds `onmessage` on channel creation
 * (before `open`), so it never drops that frame — buffering reproduces that fidelity here (finding #2).
 */
class PipeEndpoint implements LoopbackEndpoint {
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  readyState: "open" | "closed" = "open";
  peer: PipeEndpoint | null = null;
  private closeHandler: (() => void) | null = null;
  /** Backing field for the {@link onmessage} accessor — the unified inbound sink consumed by channel.ts. */
  private onmessageHandler: ((event: { data: string }) => void) | null = null;
  /** Frames that arrived before `onmessage` was bound; drained in arrival order once it is. */
  private readonly preBindBuffer: string[] = [];

  /* eslint-disable jsdoc/require-jsdoc -- in-process DataChannel shim; mirrors the lib.dom RTCDataChannel methods consumed by channel.ts */
  get onmessage(): ((event: { data: string }) => void) | null {
    return this.onmessageHandler;
  }

  // Binding the sink drains whatever arrived before the receive pump was wired (the late-join baseline).
  set onmessage(handler: ((event: { data: string }) => void) | null) {
    this.onmessageHandler = handler;
    if (!handler || this.preBindBuffer.length === 0) return;
    const drained = this.preBindBuffer.splice(0);
    for (const data of drained) queueMicrotask(() => this.onmessageHandler?.({ data }));
  }

  send(data: string): void {
    const target = this.peer;
    if (this.readyState !== "open" || target?.readyState !== "open") return;
    target.receive(data);
  }

  // Deliver now if the sink is bound (async, like a real channel); otherwise buffer until it is.
  private receive(data: string): void {
    if (this.onmessageHandler) {
      const handler = this.onmessageHandler;
      queueMicrotask(() => handler({ data }));
    } else {
      this.preBindBuffer.push(data);
    }
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
   * @param opts - Self id + role; `passive` is honored to model the star (two passive peers never pipe).
   * @returns The live in-process signaling session.
   * @example
   * ```ts
   * const session = await inMemory().join("K7M2QX", { selfId: "host_root" });
   * ```
   */
  const join = async (code: string, opts: SignalingJoinOpts): Promise<SignalingSessionImpl> => {
    // Get or create the in-memory room for this code.
    const room = rooms.get(code) ?? { members: new Map<string, Member>() };
    rooms.set(code, room);

    // Build this joiner's Member record (its onPeer/onSignal callbacks are bound below).
    const self: Member = {
      selfId: opts.selfId,
      passive: opts.passive ?? false,
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
      // Star topology: two passive peers (controller↔controller) never connect — only the active host
      // offers to passive controllers. A real WebRTC star enforces this via the offer/answer asymmetry
      // (transport joins controllers `passive`, the host active); model it here so multi-controller
      // integration is faithful instead of a full mesh (contracts §1.1; finding #1).
      if (self.passive && other.passive) continue;
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
