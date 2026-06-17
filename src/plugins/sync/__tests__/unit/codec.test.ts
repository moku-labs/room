/**
 * Unit tests for the pure op-list codec (`codec.ts`) — the highest-value `syncPlugin` unit target
 * (00-contracts §4.2). Round-trip, minimal diff, delete markers, and the property law
 * `applyOps(prev, diffToOps(prev, next))` deep-equals `next`. Placeholders only — filled at build.
 *
 * @file
 * @see ../../README.md
 */
import { describe, it } from "vitest";

describe("codec", () => {
  it.todo("encodeSnapshot/decodeSnapshot round-trip is deep-equal for plain-JSON");
  it.todo("diffToOps emits the minimal Op[] for changed cells only");
  it.todo("diffToOps emits { val: null } for a deleted cell (00-contracts §4.2)");
  it.todo("diffToOps is empty for an unchanged namespace");
  it.todo("applyOps is the inverse of diff + broadcast (val: null deletes)");
  it.todo("property: applyOps(prev, diffToOps(prev, next)) deep-equals next for random JSON");
  it.todo("codec never produces or accepts non-JSON (no Map/Set/function, spec/11 §1.7)");
  it.todo("encodeNamespace yields one op per cell of the namespace");
});
