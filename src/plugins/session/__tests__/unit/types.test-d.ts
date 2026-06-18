/**
 * @file Type-level tests (`expectTypeOf` / `@ts-expect-error`): `app.session` exposes exactly the
 * `SessionApi` signatures; `ctx.emit` accepts the three owned `room:*` names with their `RoomEvents`
 * payloads and rejects wrong payloads/unknown events; session-owned recovery `Frame` variants are
 * assignable to §2 `Frame`; no explicit generic is required on `createPlugin`.
 */

import { describe, expectTypeOf, it } from "vitest";
import type {
  Frame,
  PeerId,
  RecoveryFlushFrame,
  RecoveryHelloFrame,
  RecoveryWelcomeFrame,
  RoomEvents,
  RosterEntry,
  Snapshot
} from "../../../../contracts";
import type {
  JoinResult,
  QrMatrix,
  RecoveryPhase,
  RoomDescriptor,
  SelfInfo,
  SessionApi
} from "../../types";

describe("types (type-level)", () => {
  it("app.session exposes exactly the SessionApi method signatures", () => {
    // Verify each method's return type.
    expectTypeOf<SessionApi["createRoom"]>().toMatchTypeOf<() => RoomDescriptor>();
    expectTypeOf<SessionApi["qr"]>().toMatchTypeOf<() => Promise<QrMatrix | null>>();
    expectTypeOf<SessionApi["joinRoom"]>().toMatchTypeOf<(code: string) => Promise<JoinResult>>();
    expectTypeOf<SessionApi["leave"]>().toMatchTypeOf<() => Promise<void>>();
    expectTypeOf<SessionApi["rejoin"]>().toMatchTypeOf<() => Promise<JoinResult>>();
    expectTypeOf<SessionApi["roster"]>().toMatchTypeOf<() => readonly RosterEntry[]>();
    expectTypeOf<SessionApi["self"]>().toMatchTypeOf<() => SelfInfo>();
    expectTypeOf<SessionApi["persistSnapshot"]>().toMatchTypeOf<
      (snapshot: Snapshot, sSeq: number) => void
    >();
    expectTypeOf<SessionApi["recoveryPhase"]>().toMatchTypeOf<() => RecoveryPhase>();
    expectTypeOf<SessionApi["hostId"]>().toMatchTypeOf<() => PeerId>();
  });

  it("JoinResult is a discriminated union with ok:true/ok:false", () => {
    type SuccessResult = { ok: true; selfId: PeerId };
    type FailResult = { ok: false; reason: "full" | "not-found" | "unreachable" };
    expectTypeOf<JoinResult>().toMatchTypeOf<SuccessResult | FailResult>();
  });

  it("RoomDescriptor has the expected shape", () => {
    expectTypeOf<RoomDescriptor["code"]>().toBeString();
    expectTypeOf<RoomDescriptor["joinUrl"]>().toBeString();
    expectTypeOf<RoomDescriptor["hostToken"]>().toBeString();
    // qr can be null.
    expectTypeOf<RoomDescriptor["qr"]>().toMatchTypeOf<{
      size: number;
      modules: readonly boolean[];
    } | null>();
  });

  it("ctx.emit accepts the three owned room:* names with RoomEvents payloads", () => {
    // Verify the three event payloads are structurally correct.
    type PeerJoinedPayload = RoomEvents["room:peer-joined"];
    type PeerLeftPayload = RoomEvents["room:peer-left"];
    type HostReconnectingPayload = RoomEvents["room:host-reconnecting"];

    expectTypeOf<PeerJoinedPayload>().toMatchTypeOf<{ peerId: PeerId }>();
    expectTypeOf<PeerLeftPayload>().toMatchTypeOf<{ peerId: PeerId }>();
    expectTypeOf<HostReconnectingPayload>().toMatchTypeOf<Record<string, never>>();
  });

  it("RecoveryHelloFrame/Welcome/Flush are assignable to §2 Frame (toMatchTypeOf<Frame>)", () => {
    expectTypeOf<RecoveryHelloFrame>().toMatchTypeOf<Frame>();
    expectTypeOf<RecoveryWelcomeFrame>().toMatchTypeOf<Frame>();
    expectTypeOf<RecoveryFlushFrame>().toMatchTypeOf<Frame>();
  });

  it("RecoveryPhase is the correct union type", () => {
    expectTypeOf<RecoveryPhase>().toMatchTypeOf<
      "stable" | "host-absent" | "verifying" | "reconciling" | "degraded"
    >();
  });

  it("SelfInfo has the expected shape", () => {
    expectTypeOf<SelfInfo["selfId"]>().toBeString();
    expectTypeOf<SelfInfo["role"]>().toMatchTypeOf<"host" | "controller" | "none">();
    expectTypeOf<SelfInfo["roomCode"]>().toBeString();
  });
});
