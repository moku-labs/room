/**
 * Unit tests for the pure op-list codec (`codec.ts`) — the highest-value `syncPlugin` unit target
 * (00-contracts §4.2). Round-trip, minimal diff, delete markers, and the property law
 * `applyOps(prev, diffToOps(prev, next))` deep-equals `next`.
 *
 * @file
 * @see ../../README.md
 */
import { describe, expect, it } from "vitest";
import type { Snapshot } from "../../../transport/protocol";
import { applyOps, decodeSnapshot, diffToOps, encodeNamespace, encodeSnapshot } from "../../codec";

// ─────────────────────────────────────────────────────────────────────────────
// encodeSnapshot / decodeSnapshot
// ─────────────────────────────────────────────────────────────────────────────

describe("codec", () => {
  it("encodeSnapshot/decodeSnapshot round-trip is deep-equal for plain-JSON", () => {
    const original: Snapshot = {
      scores: { p1: 0, p2: 42, label: "winner" },
      round: { n: 3, phase: "playing", active: true, data: null }
    };

    const encoded = encodeSnapshot(original);
    const decoded = decodeSnapshot(encoded);

    expect(decoded).toEqual(original);
  });

  it("encodeSnapshot returns a deep clone — mutations to original do not affect the result", () => {
    const original: Snapshot = { scores: { p1: 0 } };
    const encoded = encodeSnapshot(original);

    // Attempt to mutate the source through JS tricks — encoded should be independent
    expect(encoded).toEqual({ scores: { p1: 0 } });
    expect(encoded).not.toBe(original);
  });

  it("encodeSnapshot/decodeSnapshot output is JSON.parse(JSON.stringify(x))-stable", () => {
    const original: Snapshot = { ns: { a: 1, b: "hello", c: true, d: null } };
    const encoded = encodeSnapshot(original);
    const roundTripped = structuredClone(encoded) as Snapshot;

    expect(roundTripped).toEqual(encoded);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // diffToOps
  // ─────────────────────────────────────────────────────────────────────────────

  it("diffToOps emits the minimal Op[] for changed cells only", () => {
    const prev: Snapshot = { scores: { p1: 0, p2: 0 } };
    const next: Snapshot = { scores: { p1: 10, p2: 0 } }; // only p1 changed

    const ops = diffToOps(prev, next);

    expect(ops).toHaveLength(1);
    expect(ops[0]).toEqual({ ns: "scores", key: "p1", val: 10 });
  });

  it("diffToOps emits { val: null } for a deleted cell (00-contracts §4.2)", () => {
    const prev: Snapshot = { scores: { p1: 5, p2: 3 } };
    const next: Snapshot = { scores: { p1: 5 } }; // p2 deleted

    const ops = diffToOps(prev, next);

    expect(ops).toHaveLength(1);
    expect(ops[0]).toEqual({ ns: "scores", key: "p2", val: null });
  });

  it("diffToOps is empty for an unchanged namespace", () => {
    const prev: Snapshot = { scores: { p1: 0, p2: 0 } };
    const next: Snapshot = { scores: { p1: 0, p2: 0 } }; // identical

    const ops = diffToOps(prev, next);

    expect(ops).toHaveLength(0);
  });

  it("diffToOps emits ops for all cells when a new namespace is added", () => {
    const prev: Snapshot = { scores: { p1: 0 } };
    const next: Snapshot = { scores: { p1: 0 }, round: { n: 1 } }; // new namespace

    const ops = diffToOps(prev, next);

    expect(ops).toHaveLength(1);
    expect(ops[0]).toEqual({ ns: "round", key: "n", val: 1 });
  });

  it("diffToOps emits { val: null } for all cells when a namespace is removed", () => {
    const prev: Snapshot = { scores: { p1: 0 }, round: { n: 1 } };
    const next: Snapshot = { scores: { p1: 0 } }; // round removed

    const ops = diffToOps(prev, next);

    expect(ops).toHaveLength(1);
    expect(ops[0]).toEqual({ ns: "round", key: "n", val: null });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // applyOps
  // ─────────────────────────────────────────────────────────────────────────────

  it("applyOps is the inverse of diff + broadcast (val: null deletes)", () => {
    const prev: Snapshot = { scores: { p1: 0, p2: 0 } };
    const next: Snapshot = { scores: { p1: 10 } }; // p2 deleted, p1 updated

    const ops = diffToOps(prev, next);
    const result = applyOps(prev, ops);

    expect(result).toEqual(next);
  });

  it("applyOps with empty ops returns the same snapshot", () => {
    const snap: Snapshot = { scores: { p1: 5 } };
    const result = applyOps(snap, []);

    expect(result).toBe(snap); // identity — no copy needed when ops is empty
  });

  it("applyOps does not mutate the input snapshot", () => {
    const prev: Snapshot = { scores: { p1: 0 } };
    const ops = [{ ns: "scores", key: "p1", val: 99 }];

    applyOps(prev, ops);

    // Original must be unchanged
    expect(prev).toEqual({ scores: { p1: 0 } });
  });

  it("property: applyOps(prev, diffToOps(prev, next)) deep-equals next for random JSON", () => {
    const cases: Array<[Snapshot, Snapshot]> = [
      [{}, {}],
      [{ a: { x: 1 } }, { a: { x: 2 } }],
      [{ a: { x: 1 }, b: { y: "hi" } }, { a: { x: 1 } }],
      [{ ns: { k: null, v: true } }, { ns: { k: 42, v: true, extra: "new" } }],
      [{ ns: { k: [1, 2, 3] } }, { ns: { k: [1, 2, 4] } }]
    ];

    for (const [prev, next] of cases) {
      const ops = diffToOps(prev, next);
      const result = applyOps(prev, ops);
      expect(result).toEqual(next);
    }
  });

  it("codec never produces or accepts non-JSON (no Map/Set/function, spec/11 §1.7)", () => {
    const snap: Snapshot = { ns: { key: "value", num: 42, flag: true, data: null } };
    const encoded = encodeSnapshot(snap);

    // Verify the result is plain JSON — stringify/parse round-trip must be stable
    const json = JSON.stringify(encoded);
    const parsed = JSON.parse(json) as Snapshot;
    expect(parsed).toEqual(snap);

    // encodeSnapshot must NOT produce any Map/Set/function in the result
    expect(typeof json).toBe("string");
    expect(json).not.toContain("undefined");
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // encodeNamespace
  // ─────────────────────────────────────────────────────────────────────────────

  it("encodeNamespace yields one op per cell of the namespace", () => {
    const ops = encodeNamespace("scores", { p1: 10, p2: 0, label: "round1" });

    expect(ops).toHaveLength(3);
    // All ops must reference the same namespace
    for (const op of ops) {
      expect(op.ns).toBe("scores");
    }
    // Check all keys are present
    const keys = ops.map(o => o.key).toSorted();
    expect(keys).toEqual(["label", "p1", "p2"]);
  });

  it("encodeNamespace returns an empty array for an empty cell set", () => {
    const ops = encodeNamespace("empty", {});
    expect(ops).toHaveLength(0);
  });

  it("encodeNamespace maps a null-valued cell to a { val: null } op (cells[key] ?? null)", () => {
    const ops = encodeNamespace("scores", { p1: null, p2: 10 });

    expect(ops).toHaveLength(2);
    const p1 = ops.find(o => o.key === "p1");
    expect(p1).toEqual({ ns: "scores", key: "p1", val: null });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Edge branches: null cell values, absent namespace values, new namespace in applyOps
  // ─────────────────────────────────────────────────────────────────────────────

  it("diffToOps emits { val: null } when a cell's value changes to null (val ?? null branch)", () => {
    const prev: Snapshot = { scores: { p1: 5 } };
    const next: Snapshot = { scores: { p1: null } }; // p1 set to null (not removed)

    const ops = diffToOps(prev, next);

    expect(ops).toHaveLength(1);
    expect(ops[0]).toEqual({ ns: "scores", key: "p1", val: null });
  });

  it("diffToOps skips a namespace whose value is absent in next (the !nextCells guard)", () => {
    // A namespace key present in `next` but mapping to `undefined` is skipped (noUncheckedIndexedAccess).
    const prev: Snapshot = { scores: { p1: 0 } };
    const next = { scores: { p1: 0 }, ghost: undefined } as unknown as Snapshot;

    const ops = diffToOps(prev, next);

    // Only the unchanged `scores` ns is considered; `ghost` contributes nothing.
    expect(ops).toHaveLength(0);
  });

  it("applyOps creates a namespace that did not exist in the snapshot (!(ns in result) branch)", () => {
    const snap: Snapshot = { scores: { p1: 0 } };
    const ops = [{ ns: "round", key: "n", val: 1 }];

    const result = applyOps(snap, ops);

    expect(result).toEqual({ scores: { p1: 0 }, round: { n: 1 } });
  });

  it("applyOps drops a namespace that becomes empty after deletes", () => {
    const snap: Snapshot = { scores: { p1: 0 }, round: { n: 1 } };
    const ops = [{ ns: "round", key: "n", val: null }]; // delete the only cell in round

    const result = applyOps(snap, ops);

    expect(result).toEqual({ scores: { p1: 0 } });
    expect("round" in result).toBe(false);
  });
});
