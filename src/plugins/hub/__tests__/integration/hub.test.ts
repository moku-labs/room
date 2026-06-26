/**
 * @file Integration test for the Hub DO (Cycle-2 W3): the end-to-end signaling flow a real
 * two-client session produces — host + controller join, the host↔controller handshake relays through the
 * DO, then a host reload reclaims the warm room and the controller is re-announced. Drives the DO against
 * the lightweight Hibernation/SQLite fakes; Wave-4's Playwright/wrangler run covers the same flow over
 * real `workerd` + WebRTC.
 * @see ../../hub-do
 */
import { describe, expect, it } from "vitest";
import type { ServerEnvelope } from "../../../transport/protocol";
import { asWs, makeFakeRoom } from "../fakes";

/** Collects every `relay` envelope a socket received. */
function relaysTo(sent: ServerEnvelope[]): ServerEnvelope[] {
  return sent.filter(e => e.kind === "relay");
}

describe("Hub DO — full handshake + reclaim flow", () => {
  it("brokers join → SDP relay → host reload reclaim end-to-end", async () => {
    const fake = makeFakeRoom();
    const room = fake.room;

    // 1. Host joins; gets a reclaim token.
    const host = fake.addSocket();
    await room.webSocketMessage(
      asWs(host),
      JSON.stringify({ kind: "join", selfId: "host_root", role: "host" })
    );
    const hostAck = host.sent[0];
    const token = hostAck?.kind === "join-ack" ? hostAck.reclaimToken : "";
    expect(token).not.toBe("");

    // 2. Controller joins; the host is told via peer-arrived.
    const ctrl = fake.addSocket();
    await room.webSocketMessage(
      asWs(ctrl),
      JSON.stringify({ kind: "join", selfId: "p_ab12", role: "controller" })
    );
    expect(host.sent).toContainEqual({
      kind: "peer-arrived",
      peerId: "p_ab12",
      role: "controller"
    });

    // 3. Host offers → controller; controller answers → host (the DO relays both, opaque).
    await room.webSocketMessage(
      asWs(host),
      JSON.stringify({ kind: "relay", to: "p_ab12", msg: { kind: "offer", sdp: "OFFER" } })
    );
    await room.webSocketMessage(
      asWs(ctrl),
      JSON.stringify({ kind: "relay", to: "host_root", msg: { kind: "answer", sdp: "ANSWER" } })
    );
    expect(relaysTo(ctrl.sent)).toContainEqual({
      kind: "relay",
      from: "host_root",
      msg: { kind: "offer", sdp: "OFFER" }
    });
    expect(relaysTo(host.sent)).toContainEqual({
      kind: "relay",
      from: "p_ab12",
      msg: { kind: "answer", sdp: "ANSWER" }
    });

    // 4. Host reloads: a fresh socket reclaims the warm room with the persisted token.
    fake.sockets.splice(fake.sockets.indexOf(host), 1);
    const host2 = fake.addSocket();
    await room.webSocketMessage(
      asWs(host2),
      JSON.stringify({ kind: "reclaim", selfId: "host_v2", reclaimToken: token })
    );

    const reclaimAck = host2.lastSent();
    expect(reclaimAck?.kind).toBe("reclaim-ack");
    if (reclaimAck?.kind === "reclaim-ack") expect(reclaimAck.peers).toEqual(["p_ab12"]);
    // The surviving controller learns the host is back so it re-handshakes.
    expect(ctrl.sent).toContainEqual({ kind: "peer-arrived", peerId: "host_v2", role: "host" });
  });
});
