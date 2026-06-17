/**
 * @file Unit tests for `createTransportState`.
 * @see ../../state.ts
 */
import { describe, it } from "vitest";

describe("createTransportState", () => {
  it.todo("returns role 'idle' with an empty peers map");
  it.todo("returns null session and null heartbeat/frame-consumer");
  it.todo("returns an empty warned de-dup set");
  it.todo("returns a fresh object per call (no shared module-level state)");
});
