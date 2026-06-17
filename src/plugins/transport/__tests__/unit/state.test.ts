/**
 * @file Unit tests for `createTransportState`.
 * @see ../../state.ts
 */
import { describe, expect, it } from "vitest";
import { createTransportState } from "../../state";

describe("createTransportState", () => {
  it("returns role 'idle' with an empty peers map", () => {
    const state = createTransportState();
    expect(state.role).toBe("idle");
    expect(state.peers).toBeInstanceOf(Map);
    expect(state.peers.size).toBe(0);
  });

  it("returns an empty selfId", () => {
    expect(createTransportState().selfId).toBe("");
  });

  it("returns null session and null heartbeat/frame-consumer", () => {
    const state = createTransportState();
    expect(state.session).toBeNull();
    expect(state.heartbeatTimer).toBeNull();
    expect(state.frameConsumer).toBeNull();
  });

  it("returns an empty warned de-dup set", () => {
    const state = createTransportState();
    expect(state.warned).toBeInstanceOf(Set);
    expect(state.warned.size).toBe(0);
  });

  it("returns a fresh object per call (no shared module-level state)", () => {
    const a = createTransportState();
    const b = createTransportState();
    expect(a).not.toBe(b);
    expect(a.peers).not.toBe(b.peers);
    expect(a.warned).not.toBe(b.warned);

    a.role = "host";
    a.peers.set("p_x", {} as never);
    expect(b.role).toBe("idle");
    expect(b.peers.size).toBe(0);
  });
});
