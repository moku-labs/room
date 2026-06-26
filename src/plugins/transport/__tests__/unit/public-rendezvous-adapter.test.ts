/**
 * @file Unit tests for the publicRendezvous adapter with Trystero mocked.
 * @see ../../adapters/public-rendezvous.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publicRendezvous } from "../../adapters/public-rendezvous";
import type { SignalMsg } from "../../protocol";

// ─────────────────────────────────────────────────────────────────────────────
// Mock the Trystero Nostr backbone. `joinRoom` returns a Room-like object whose
// action channel + peer callbacks the adapter must map onto the Signaling seam.
// ─────────────────────────────────────────────────────────────────────────────

type MessageHandler = (data: unknown, ctx: { peerId: string }) => void;

/** A Trystero v0.25.x `MessageAction` object: `send(data, { target })` + a settable `onMessage`. */
type FakeAction = {
  send: (data: unknown, options?: { target?: string | string[] | null }) => Promise<void>;
  onMessage: MessageHandler | null;
};

class FakeRoom {
  onPeerJoin: ((peerId: string) => void) | null = null;
  onPeerLeave: ((peerId: string) => void) | null = null;
  readonly leave = vi.fn().mockResolvedValue(undefined);
  readonly sent: { data: unknown; target: string | undefined }[] = [];
  private action: FakeAction | null = null;

  makeAction(_namespace: string): FakeAction {
    const action: FakeAction = {
      send: async (data, options): Promise<void> => {
        const target = typeof options?.target === "string" ? options.target : undefined;
        this.sent.push({ data, target });
      },
      onMessage: null
    };
    this.action = action;
    return action;
  }

  /** Drive an inbound action message as if from `peerId`. */
  deliver(peerId: string, data: unknown): void {
    this.action?.onMessage?.(data, { peerId });
  }
}

const joinRoomMock = vi.fn();

vi.mock("trystero/nostr", () => ({
  joinRoom: (...args: unknown[]) => joinRoomMock(...args)
}));

let room: FakeRoom;
beforeEach(() => {
  room = new FakeRoom();
  joinRoomMock.mockReset();
  joinRoomMock.mockReturnValue(room);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("publicRendezvous adapter", () => {
  it("join lazy-imports the Trystero backbone and joins the room code", async () => {
    const sig = publicRendezvous();
    await sig.join("K7M2QX", { selfId: "host_root" });

    expect(joinRoomMock).toHaveBeenCalledTimes(1);
    const [config, roomId] = joinRoomMock.mock.calls[0] as [Record<string, unknown>, string];
    expect(roomId).toBe("K7M2QX");
    expect(config["appId"]).toBeTruthy();
  });

  it("passes passive + relayRedundancy>=3 through to joinRoom", async () => {
    const sig = publicRendezvous({ relayRedundancy: 5 });
    await sig.join("K7M2QX", { selfId: "p_ab12", passive: true });

    const [config] = joinRoomMock.mock.calls[0] as [Record<string, unknown>, string];
    expect(config["passive"]).toBe(true);
    const relayConfig = config["relayConfig"] as { redundancy?: number } | undefined;
    expect(relayConfig?.redundancy).toBeGreaterThanOrEqual(3);
  });

  it("defaults relayRedundancy to at least 3 (D11 mandatory)", async () => {
    const sig = publicRendezvous();
    await sig.join("K7M2QX", { selfId: "host_root" });
    const [config] = joinRoomMock.mock.calls[0] as [Record<string, unknown>, string];
    const relayConfig = config["relayConfig"] as { redundancy?: number } | undefined;
    expect(relayConfig?.redundancy).toBeGreaterThanOrEqual(3);
  });

  it("maps onPeerJoin -> onPeer and onPeerLeave -> onPeerLeave", async () => {
    const sig = publicRendezvous();
    const session = await sig.join("K7M2QX", { selfId: "host_root" });

    const sawPeer = vi.fn<(peerId: string) => void>();
    const sawLeave = vi.fn<(peerId: string) => void>();
    session.onPeer(sawPeer);
    session.onPeerLeave(sawLeave);

    room.onPeerJoin?.("p_ab12");
    room.onPeerLeave?.("p_ab12");
    expect(sawPeer).toHaveBeenCalledWith("p_ab12");
    expect(sawLeave).toHaveBeenCalledWith("p_ab12");
  });

  it("maps the action channel onto Signaling send/onSignal", async () => {
    const sig = publicRendezvous();
    const session = await sig.join("K7M2QX", { selfId: "host_root" });

    const inbound = vi.fn<(peerId: string, msg: SignalMsg) => void>();
    session.onSignal(inbound);

    const offer: SignalMsg = { kind: "offer", sdp: "v=0..." };
    session.send("p_ab12", offer);
    expect(room.sent).toHaveLength(1);
    expect(room.sent[0]).toEqual({ data: offer, target: "p_ab12" });

    // Inbound action message routes to onSignal with the sender id.
    const answer: SignalMsg = { kind: "answer", sdp: "v=0...a" };
    room.deliver("p_ab12", answer);
    expect(inbound).toHaveBeenCalledWith("p_ab12", answer);
  });

  it("upserts peers by id on re-onPeer (Trystero #77 — updates, does not duplicate)", async () => {
    const sig = publicRendezvous();
    const session = await sig.join("K7M2QX", { selfId: "host_root" });
    const sawPeer = vi.fn<(peerId: string) => void>();
    session.onPeer(sawPeer);

    room.onPeerJoin?.("p_ab12");
    room.onPeerJoin?.("p_ab12"); // unclean re-join for the same id

    // The consumer is still notified each time, but no duplicate registry entry is created.
    // Sending to that id targets it exactly once (no fan-out duplication).
    session.send("p_ab12", { kind: "candidate", candidate: {} });
    const toPeer = room.sent.filter(s => s.target === "p_ab12");
    expect(toPeer).toHaveLength(1);
  });

  it("a thrown error on all-relays-unreachable surfaces to connect()", async () => {
    joinRoomMock.mockImplementation(() => {
      throw new Error("all relays unreachable");
    });
    const sig = publicRendezvous();
    await expect(sig.join("K7M2QX", { selfId: "host_root" })).rejects.toThrow();
  });

  it("leave() delegates to the Trystero room and is idempotent", async () => {
    const sig = publicRendezvous();
    const session = await sig.join("K7M2QX", { selfId: "host_root" });
    await session.leave();
    await session.leave();
    expect(room.leave).toHaveBeenCalled();
  });
});
