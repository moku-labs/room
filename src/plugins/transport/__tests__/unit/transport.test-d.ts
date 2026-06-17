/**
 * @file Type-level tests for the transport public surface.
 * @see ../../types.ts
 */
import { describe, expectTypeOf, it } from "vitest";
import type { Frame, IceCandidateInit, Signaling, SignalMsg, Wire } from "../../../../contracts";
import { inMemory } from "../../adapters/in-memory";
import { publicRendezvous } from "../../adapters/public-rendezvous";
import type { ConnectOpts, TransportApi } from "../../types";

describe("transport types", () => {
  it("wire().send accepts every Frame variant and rejects a non-Frame object", () => {
    const wire = {} as Wire;
    const intent: Frame = { t: "intent", name: "move", payload: {}, cSeq: 1 };
    const snap: Frame = { t: "sync-snap", snapshot: {}, sSeq: 0 };
    const ping: Frame = { t: "ping", ts: 1 };
    expectTypeOf(wire.send).toBeCallableWith("p1", intent);
    expectTypeOf(wire.send).toBeCallableWith("p1", snap);
    expectTypeOf(wire.send).toBeCallableWith("p1", ping);

    // @ts-expect-error — a bare object without a known `t` tag is not a Frame.
    wire.send("p1", { t: "not-a-frame" });
    // @ts-expect-error — a missing payload field is rejected.
    wire.send("p1", { t: "intent", name: "x" });
  });

  it("connect requires { role, selfId, code } and rejects a missing code", () => {
    const api = {} as TransportApi;
    const opts: ConnectOpts = { role: "host", selfId: "h", code: "K7M2QX" };
    expectTypeOf(api.connect).toBeCallableWith(opts);

    // @ts-expect-error — `code` is required.
    api.connect({ role: "host", selfId: "h" });
    // @ts-expect-error — `role` must be host | controller.
    api.connect({ role: "spectator", selfId: "h", code: "K7M2QX" });
  });

  it("peers() returns a readonly array of peer ids", () => {
    const api = {} as TransportApi;
    expectTypeOf(api.peers()).toEqualTypeOf<readonly string[]>();
  });

  it("inMemory() and publicRendezvous() are both assignable to Signaling (D12)", () => {
    expectTypeOf(inMemory()).toExtend<Signaling>();
    expectTypeOf(publicRendezvous()).toExtend<Signaling>();
  });

  it("SignalMsg/IceCandidateInit carry no lib.dom types (structural, DOM-free)", () => {
    // An IceCandidateInit is constructible from plain literals, with no DOM dependency.
    const candidate: IceCandidateInit = { candidate: "c", sdpMid: null, sdpMLineIndex: 0 };
    const offer: SignalMsg = { kind: "offer", sdp: "v=0" };
    const trickle: SignalMsg = { kind: "candidate", candidate };
    expectTypeOf(offer).toExtend<SignalMsg>();
    expectTypeOf(trickle).toExtend<SignalMsg>();
    // The candidate payload is a plain object literal type, not an RTCIceCandidate.
    expectTypeOf<IceCandidateInit>().not.toEqualTypeOf<RTCIceCandidate>();
  });
});
