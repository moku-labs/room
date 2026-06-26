/**
 * @file Unit tests for the Hub DO message dispatch (Cycle-2 W3): join / reclaim / relay handling,
 * the join-window guard (1008), the controller cap (`full`), star topology (passive↔passive never
 * announced), relay opacity (no gameplay path), and the safe-guarded Alarm TTL. Drives the DO against the
 * lightweight Hibernation/SQLite fakes (the DO's `fetch()` Hibernation accept is covered by Wave-4's
 * Playwright/wrangler run).
 * @see ../../hub-do
 * @see ../fakes
 */
import { describe, expect, it } from "vitest";
import type { ClientEnvelope } from "../../../transport/protocol";
import { MAX_CONTROLLERS } from "../../../transport/protocol";
import type { Hub } from "../../hub-do";
import { asWs, type FakeSocket, makeFakeRoom } from "../fakes";

/** Sends a `join` envelope from `ws` and awaits dispatch. */
async function join(
  room: Hub,
  ws: FakeSocket,
  selfId: string,
  role: "host" | "controller"
): Promise<void> {
  await room.webSocketMessage(asWs(ws), JSON.stringify({ kind: "join", selfId, role }));
}

describe("Hub DO — join", () => {
  it("acks a host join with empty peers + a reclaim token and persists the row", async () => {
    const fake = makeFakeRoom();
    const host = fake.addSocket();

    await join(fake.room, host, "host_root", "host");

    const ack = host.lastSent();
    expect(ack?.kind).toBe("join-ack");
    if (ack?.kind === "join-ack") {
      expect(ack.peers).toEqual([]);
      expect(typeof ack.reclaimToken).toBe("string");
      expect(ack.reclaimToken.length).toBeGreaterThan(0);
    }
    expect(fake.sql.rows.has("host_root")).toBe(true);
  });

  it("gives a joining controller the host in join-ack and announces it to the host", async () => {
    const fake = makeFakeRoom();
    const host = fake.addSocket();
    const ctrl = fake.addSocket();

    await join(fake.room, host, "host_root", "host");
    await join(fake.room, ctrl, "p_ab12", "controller");

    const ack = ctrl.lastSent();
    expect(ack?.kind).toBe("join-ack");
    if (ack?.kind === "join-ack") expect(ack.peers).toEqual(["host_root"]);

    // The host learns of the controller via peer-arrived.
    expect(host.sent).toContainEqual({
      kind: "peer-arrived",
      peerId: "p_ab12",
      role: "controller"
    });
  });

  it("never announces one passive controller to another (star topology)", async () => {
    const fake = makeFakeRoom();
    const host = fake.addSocket();
    const c1 = fake.addSocket();
    const c2 = fake.addSocket();

    await join(fake.room, host, "host_root", "host");
    await join(fake.room, c1, "p_c1", "controller");
    await join(fake.room, c2, "p_c2", "controller");

    // c2's join-ack contains only the host, never c1.
    const ack = c2.lastSent();
    if (ack?.kind === "join-ack") expect(ack.peers).toEqual(["host_root"]);
    // c1 is never told about c2.
    expect(c1.sent.some(e => e.kind === "peer-arrived" && e.peerId === "p_c2")).toBe(false);
    // The host is told about both controllers.
    expect(host.sent.filter(e => e.kind === "peer-arrived")).toHaveLength(2);
  });

  it("closes a late join with 1008 (join-window guard)", async () => {
    const fake = makeFakeRoom();
    const late = fake.addSocket(Date.now() - 20_000); // opened 20s ago (> 10s window)

    await join(fake.room, late, "p_late", "controller");

    expect(late.closed?.code).toBe(1008);
    expect(fake.sql.rows.has("p_late")).toBe(false);
  });

  it("closes a second join on an already-handshook socket with 1008", async () => {
    const fake = makeFakeRoom();
    const host = fake.addSocket();

    await join(fake.room, host, "host_root", "host");
    await join(fake.room, host, "host_again", "host");

    expect(host.closed?.code).toBe(1008);
  });

  it("rejects a controller past the cap with {kind:'full'} + close", async () => {
    const fake = makeFakeRoom();
    const host = fake.addSocket();
    await join(fake.room, host, "host_root", "host");
    for (let index = 0; index < MAX_CONTROLLERS; index += 1) {
      await join(fake.room, fake.addSocket(), `p_${index}`, "controller");
    }

    const overflow = fake.addSocket();
    await join(fake.room, overflow, "p_overflow", "controller");

    expect(overflow.lastSent()?.kind).toBe("full");
    expect(overflow.closed?.code).toBe(1008);
    expect(fake.sql.rows.has("p_overflow")).toBe(false);
  });
});

describe("Hub DO — relay (opaque, no gameplay path)", () => {
  it("delivers a relay to the target and persists the in-flight SDP", async () => {
    const fake = makeFakeRoom();
    const host = fake.addSocket();
    const ctrl = fake.addSocket();
    await join(fake.room, host, "host_root", "host");
    await join(fake.room, ctrl, "p_ab12", "controller");

    const offer = { kind: "offer" as const, sdp: "v=0...offer" };
    await fake.room.webSocketMessage(
      asWs(host),
      JSON.stringify({ kind: "relay", to: "p_ab12", msg: offer })
    );

    expect(ctrl.sent).toContainEqual({ kind: "relay", from: "host_root", msg: offer });
    expect(fake.sql.rows.get("host_root")?.sdp_offer).toBe("v=0...offer");
  });

  it("drops a relay to an unknown target without throwing", async () => {
    const fake = makeFakeRoom();
    const host = fake.addSocket();
    await join(fake.room, host, "host_root", "host");

    await expect(
      fake.room.webSocketMessage(
        asWs(host),
        JSON.stringify({ kind: "relay", to: "ghost", msg: { kind: "answer", sdp: "x" } })
      )
    ).resolves.toBeUndefined();
  });
});

describe("Hub DO — reclaim (host reload)", () => {
  it("re-binds the host on a valid token and re-announces it to controllers", async () => {
    const fake = makeFakeRoom();
    const host = fake.addSocket();
    const ctrl = fake.addSocket();
    await join(fake.room, host, "host_root", "host");
    await join(fake.room, ctrl, "p_ab12", "controller");

    const token = host.sent[0]?.kind === "join-ack" ? host.sent[0].reclaimToken : "";
    // Host reload: old socket is gone, a fresh one reclaims with the persisted token + a new selfId.
    fake.sockets.splice(fake.sockets.indexOf(host), 1);
    const host2 = fake.addSocket();
    await fake.room.webSocketMessage(
      asWs(host2),
      JSON.stringify({ kind: "reclaim", selfId: "host_v2", reclaimToken: token })
    );

    const ack = host2.lastSent();
    expect(ack?.kind).toBe("reclaim-ack");
    if (ack?.kind === "reclaim-ack") expect(ack.peers).toEqual(["p_ab12"]);
    // The live controller is told the host returned (peer-arrived for the new host id).
    expect(ctrl.sent).toContainEqual({
      kind: "peer-arrived",
      peerId: "host_v2",
      role: "host"
    });
    // The stale host row is superseded by the reclaiming id, keeping the same token.
    expect(fake.sql.rows.has("host_root")).toBe(false);
    expect(fake.sql.rows.get("host_v2")?.reclaim_token).toBe(token);
  });

  it("rejects an unknown reclaim token with an error + close 1008", async () => {
    const fake = makeFakeRoom();
    const ws = fake.addSocket();

    await fake.room.webSocketMessage(
      asWs(ws),
      JSON.stringify({ kind: "reclaim", selfId: "x", reclaimToken: "nope" })
    );

    expect(ws.lastSent()?.kind).toBe("error");
    expect(ws.closed?.code).toBe(1008);
  });
});

describe("Hub DO — no gameplay path (D2/D21)", () => {
  it("rejects a §2 gameplay Frame on a relay envelope at the type level", () => {
    // The relay variant's `msg` is a §1 SignalMsg; a §2 gameplay Frame (here a heartbeat ping) is
    // structurally rejected — the DO has no gameplay-relay case and cannot carry gameplay (D2/D21).
    // @ts-expect-error - { t: "ping", ts } is a gameplay Frame, not a SignalMsg.
    const bad: ClientEnvelope = { kind: "relay", to: "p_ab12", msg: { t: "ping", ts: 0 } };
    expect(bad.kind).toBe("relay");
  });
});

describe("Hub DO — unknown frames", () => {
  it("replies error 1003 for an unknown kind", async () => {
    const fake = makeFakeRoom();
    const ws = fake.addSocket();

    await fake.room.webSocketMessage(asWs(ws), JSON.stringify({ kind: "bogus" }));

    const err = ws.lastSent();
    expect(err).toEqual({ kind: "error", code: 1003, message: "unknown kind" });
  });

  it("replies error 1003 for non-JSON", async () => {
    const fake = makeFakeRoom();
    const ws = fake.addSocket();

    await fake.room.webSocketMessage(asWs(ws), "not json {");

    expect(ws.lastSent()?.kind).toBe("error");
  });

  it("rejects a malformed join (missing selfId) without writing a row (D24 hardening)", async () => {
    const fake = makeFakeRoom();
    const ws = fake.addSocket();

    await fake.room.webSocketMessage(asWs(ws), JSON.stringify({ kind: "join", role: "host" }));

    expect(ws.lastSent()?.kind).toBe("error");
    expect([...fake.sql.rows.keys()]).toEqual([]); // no "undefined" peer row leaked
  });

  it("rejects a relay with no target (D24 hardening)", async () => {
    const fake = makeFakeRoom();
    const ws = fake.addSocket();

    await fake.room.webSocketMessage(
      asWs(ws),
      JSON.stringify({ kind: "relay", msg: { kind: "offer", sdp: "x" } })
    );

    expect(ws.lastSent()?.kind).toBe("error");
  });
});

describe("Hub DO — webSocketClose", () => {
  it("deletes a controller row and announces peer-left to the star subset", async () => {
    const fake = makeFakeRoom();
    const host = fake.addSocket();
    const ctrl = fake.addSocket();
    await join(fake.room, host, "host_root", "host");
    await join(fake.room, ctrl, "p_ab12", "controller");

    await fake.room.webSocketClose(asWs(ctrl));

    expect(fake.sql.rows.has("p_ab12")).toBe(false);
    expect(host.sent).toContainEqual({ kind: "peer-left", peerId: "p_ab12" });
  });

  // Regression (Cycle-2 W4, real-workerd): a host reload closes the OLD socket FIRST, then reclaims with
  // the persisted token. The host row + its reclaim token MUST survive that close — deleting it (as a
  // controller's row is) makes `findPeerByReclaimToken` miss and rejects the warm re-entry with 1008. The
  // W3 fake-based reclaim test skipped the close, so the wrangler/Playwright run is what surfaced this.
  it("KEEPS the host row on close so a subsequent warm reclaim still succeeds", async () => {
    const fake = makeFakeRoom();
    const host = fake.addSocket();
    const ctrl = fake.addSocket();
    await join(fake.room, host, "host_root", "host");
    await join(fake.room, ctrl, "p_ab12", "controller");
    const token = host.sent[0]?.kind === "join-ack" ? host.sent[0].reclaimToken : "";

    await fake.room.webSocketClose(asWs(host));

    // Row preserved (token intact), but the controller is still told the host left.
    expect(fake.sql.rows.get("host_root")?.reclaim_token).toBe(token);
    expect(ctrl.sent).toContainEqual({ kind: "peer-left", peerId: "host_root" });

    // The reload's fresh socket reclaims with the persisted token → re-bind, NOT a 1008 rejection.
    fake.sockets.splice(fake.sockets.indexOf(host), 1);
    const host2 = fake.addSocket();
    await fake.room.webSocketMessage(
      asWs(host2),
      JSON.stringify({ kind: "reclaim", selfId: "host_v2", reclaimToken: token })
    );

    expect(host2.lastSent()?.kind).toBe("reclaim-ack");
    expect(fake.sql.rows.has("host_root")).toBe(false); // superseded by the reclaiming id
    expect(fake.sql.rows.get("host_v2")?.reclaim_token).toBe(token);
  });
});

describe("Hub DO — alarm (safe-guarded TTL)", () => {
  it("reschedules while sockets are live", async () => {
    const fake = makeFakeRoom();
    fake.addSocket();

    await fake.room.alarm();

    expect(fake.alarmAt()).not.toBeNull();
    expect(fake.isDeleted()).toBe(false);
  });

  it("tears the room down only when no sockets remain", async () => {
    const fake = makeFakeRoom();

    await fake.room.alarm();

    expect(fake.isDeleted()).toBe(true);
  });
});
