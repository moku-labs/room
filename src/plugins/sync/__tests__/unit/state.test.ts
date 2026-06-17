/**
 * Unit tests for `createSyncState` (`state.ts`): the documented defaults and plain-JSON serializability of
 * every at-rest field (`throttleHandle` and `engine` are the two non-serialized runtime cells, both `null`
 * at rest). Placeholders only — filled at build.
 *
 * @file
 * @see ../../README.md
 */
import { describe, it } from "vitest";

describe("createSyncState", () => {
  it.todo("returns snapshot:{}, dirty:{}, sSeq:0, ready:false, stale:false, broadcasting:false");
  it.todo("throttleHandle and engine are both null at rest");
  it.todo("every serialized field is plain-JSON (JSON.parse(JSON.stringify(x)) stable)");
});
