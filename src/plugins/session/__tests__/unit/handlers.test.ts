/**
 * @file Unit tests for `handlers.ts` factories with a mock ctx (transport stubbed via `require`,
 * `emit: vi.fn()`): each handler performs the right roster mutation + the right `room:*` emission, and NO
 * wire frame is ever routed through `emit` (assert `emit` is only ever called with `room:*` names).
 */

import { describe, it } from "vitest";

describe("handlers", () => {
  it.todo("handlePeerConnected: upserts roster + emits room:peer-joined");
  it.todo("handlePeerConnected: rejects the 9th controller without emitting");
  it.todo("handlePeerLost: removes from roster + emits room:peer-left");
  it.todo("handleHostChannelLost: enters host-absent, buffers, arms the reconnect timer");
  it.todo("handleRecoveryFrame: dispatches Hello/Welcome/Flush correctly");
  it.todo("handleStarTopologyViolation: rejects a controller<->controller channel (no event)");
  it.todo("emit is only ever called with room:* event names (no wire frames via emit)");
});
