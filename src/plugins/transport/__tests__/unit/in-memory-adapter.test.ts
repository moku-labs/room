/**
 * @file Unit tests for the inMemory signaling adapter (DOM-free contract proof, D12).
 * @see ../../adapters/in-memory.ts
 */
import { describe, expect, it, vi } from "vitest";
import type { SignalMsg } from "../../../../contracts";
import { inMemory } from "../../adapters/in-memory";

describe("inMemory adapter", () => {
  it("two sessions on the same code mutually fire onPeer", async () => {
    const sig = inMemory();
    const hostSawPeer = vi.fn<(peerId: string) => void>();
    const ctrlSawPeer = vi.fn<(peerId: string) => void>();

    const host = await sig.join("K7M2QX", { selfId: "host_root" });
    host.onPeer(hostSawPeer);

    const ctrl = await sig.join("K7M2QX", { selfId: "p_ab12", passive: true });
    ctrl.onPeer(ctrlSawPeer);

    expect(hostSawPeer).toHaveBeenCalledWith("p_ab12");
    expect(ctrlSawPeer).toHaveBeenCalledWith("host_root");

    await host.leave();
    await ctrl.leave();
  });

  it("does not fire onPeer for sessions on different codes", async () => {
    const sig = inMemory();
    const sawPeer = vi.fn<(peerId: string) => void>();

    const a = await sig.join("AAAAAA", { selfId: "a" });
    a.onPeer(sawPeer);
    const b = await sig.join("BBBBBB", { selfId: "b" });
    b.onPeer(vi.fn());

    expect(sawPeer).not.toHaveBeenCalled();
    await a.leave();
    await b.leave();
  });

  it("send/onSignal deliver SignalMsgs in-process with no RTCPeerConnection", async () => {
    const sig = inMemory();
    const host = await sig.join("K7M2QX", { selfId: "host_root" });
    const ctrl = await sig.join("K7M2QX", { selfId: "p_ab12", passive: true });

    const ctrlInbound = vi.fn<(peerId: string, msg: SignalMsg) => void>();
    ctrl.onSignal(ctrlInbound);

    const offer: SignalMsg = { kind: "offer", sdp: "v=0..." };
    host.send("p_ab12", offer);

    expect(ctrlInbound).toHaveBeenCalledWith("host_root", offer);

    // And the reverse direction (answer back).
    const hostInbound = vi.fn<(peerId: string, msg: SignalMsg) => void>();
    host.onSignal(hostInbound);
    const answer: SignalMsg = { kind: "answer", sdp: "v=0...ans" };
    ctrl.send("host_root", answer);
    expect(hostInbound).toHaveBeenCalledWith("p_ab12", answer);

    await host.leave();
    await ctrl.leave();
  });

  it("a peer that joins after onPeer is registered still fires the callback", async () => {
    const sig = inMemory();
    const host = await sig.join("K7M2QX", { selfId: "host_root" });
    const sawPeer = vi.fn<(peerId: string) => void>();
    host.onPeer(sawPeer);
    // No peers yet.
    expect(sawPeer).not.toHaveBeenCalled();

    const ctrl = await sig.join("K7M2QX", { selfId: "p_late", passive: true });
    expect(sawPeer).toHaveBeenCalledWith("p_late");

    await host.leave();
    await ctrl.leave();
  });

  it("send to a departed peer is a silent no-op (does not throw)", async () => {
    const sig = inMemory();
    const host = await sig.join("K7M2QX", { selfId: "host_root" });
    const ctrl = await sig.join("K7M2QX", { selfId: "p_ab12", passive: true });
    await ctrl.leave();

    expect(() => host.send("p_ab12", { kind: "offer", sdp: "x" })).not.toThrow();
    await host.leave();
  });

  it("fires onPeerLeave when the other session leaves", async () => {
    const sig = inMemory();
    const host = await sig.join("K7M2QX", { selfId: "host_root" });
    const ctrl = await sig.join("K7M2QX", { selfId: "p_ab12", passive: true });

    const hostSawLeave = vi.fn<(peerId: string) => void>();
    host.onPeerLeave(hostSawLeave);

    await ctrl.leave();
    expect(hostSawLeave).toHaveBeenCalledWith("p_ab12");

    await host.leave();
  });

  it("leave() is idempotent", async () => {
    const sig = inMemory();
    const host = await sig.join("K7M2QX", { selfId: "host_root" });
    await host.leave();
    await expect(host.leave()).resolves.toBeUndefined();
  });
});
