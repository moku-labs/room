/**
 * @file Unit tests for the inMemory signaling adapter (DOM-free contract proof, D12).
 * @see ../../adapters/in-memory.ts
 */
import { describe, expect, it, vi } from "vitest";
import type { SignalMsg } from "../../../../contracts";
import { inMemory } from "../../adapters/in-memory";
import type { LoopbackSignaling, WireChannel } from "../../channel";

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

  it("two passive peers (controllers) on the same code do NOT see each other — star topology", async () => {
    // The real adapter passes `passive` to Trystero so a passive peer only rendezvous with the active
    // host, never another passive peer. Model that here: without it the bus is a full mesh and a 2nd
    // controller clobbers the 1st controller's host channel (finding #1).
    const sig = inMemory();
    const host = await sig.join("K7M2QX", { selfId: "host_root" });
    const hostSaw = vi.fn<(peerId: string) => void>();
    host.onPeer(hostSaw);

    const c1 = await sig.join("K7M2QX", { selfId: "p_c1", passive: true });
    const c1Saw = vi.fn<(peerId: string) => void>();
    c1.onPeer(c1Saw);

    const c2 = await sig.join("K7M2QX", { selfId: "p_c2", passive: true });
    const c2Saw = vi.fn<(peerId: string) => void>();
    c2.onPeer(c2Saw);

    // The active host sees BOTH controllers; neither controller ever sees the other.
    expect(hostSaw.mock.calls.map(call => call[0]).toSorted()).toEqual(["p_c1", "p_c2"]);
    expect(c1Saw.mock.calls.map(call => call[0])).toEqual(["host_root"]);
    expect(c2Saw.mock.calls.map(call => call[0])).toEqual(["host_root"]);

    await host.leave();
    await c1.leave();
    await c2.leave();
  });

  it("a wire frame sent before the receiver binds onmessage is buffered, then delivered on bind", async () => {
    // The host pushes its join-baseline snapshot the instant a peer connects — one microtask BEFORE the
    // joiner wires its receive pump (handlePeerArrival → bindChannel). The loopback pipe must buffer that
    // frame rather than drop it, as a real RTCDataChannel (onmessage bound on channel creation) would not
    // drop it (finding #2).
    const sig = inMemory();
    const hostSession = await sig.join("K7M2QX", { selfId: "host_root" });
    const ctrlSession = await sig.join("K7M2QX", { selfId: "p_ab12", passive: true });

    const hostCh: WireChannel | null = (
      hostSession as unknown as LoopbackSignaling
    ).openWireChannel("p_ab12");
    const ctrlCh: WireChannel | null = (
      ctrlSession as unknown as LoopbackSignaling
    ).openWireChannel("host_root");

    // Send BEFORE binding the controller's onmessage sink (the late-join timing window).
    hostCh?.send("baseline-frame");

    const received: string[] = [];
    if (ctrlCh) {
      // Bind the sink AFTER the send — the buffered frame must still arrive (no pre-bind drop).
      // eslint-disable-next-line unicorn/prefer-add-event-listener -- the loopback WireChannel exposes only `onmessage` (no addEventListener("message")); it is the unified inbound sink, as in channel.ts.
      ctrlCh.onmessage = (event: { data: string }): void => {
        received.push(event.data);
      };
    }

    await vi.waitFor(() => expect(received).toEqual(["baseline-frame"]));

    await hostSession.leave();
    await ctrlSession.leave();
  });
});
