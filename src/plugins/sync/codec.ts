/**
 * @file The PURE op-list codec for `syncPlugin` (D4; contracts section 4.2).
 * @see README.md
 *
 * No engine state, no transport, no timers — just total functions over plain-JSON. Encodes/decodes the
 * whole-state `Snapshot` (for join/late-join/reconcile), diffs two snapshots into a minimal `Op[]`
 * (changed cells only; `val: null` doubles as the delete marker), and applies an `Op[]` to a snapshot
 * (the inverse of diff + broadcast). The codec is the highest-value unit target:
 * `applyOps(prev, diffToOps(prev, next))` must deep-equal `next` for any plain-JSON input, and it must
 * never produce or accept non-JSON (no `Map`, `Set`, function, or `undefined`-hole, spec/11 section 1.7).
 * Shared contract types are imported from `../../contracts` (D16); `Cells` is sync's internal alias.
 */
import type { Namespace, Op, Snapshot } from "../../contracts";
import type { Cells } from "./types";

/**
 * Serializes a whole `Snapshot` to the exact plain-JSON byte shape `sessionPlugin` persists and the host
 * sends in a `SyncSnapshotFrame` (contracts section 4.1, section 5.1). Deep-clones to a structurally-frozen,
 * `JSON.stringify`-safe value — never a live reference into engine state.
 *
 * @param snapshot - The authoritative `Snapshot` to encode.
 * @throws {Error} Always — skeleton stub.
 * @example
 * ```ts
 * const bytes = encodeSnapshot(state.snapshot);
 * ```
 */
export function encodeSnapshot(snapshot: Snapshot): Snapshot {
  throw new Error("not implemented");
}

/**
 * Deserializes a received/persisted `Snapshot` back into engine state shape (contracts section 4.1). The
 * inverse of {@link encodeSnapshot}; deep-equal round-trips for any plain-JSON input.
 *
 * @param snapshot - The plain-JSON `Snapshot` to decode.
 * @throws {Error} Always — skeleton stub.
 * @example
 * ```ts
 * const restored = decodeSnapshot(JSON.parse(persisted));
 * ```
 */
export function decodeSnapshot(snapshot: Snapshot): Snapshot {
  throw new Error("not implemented");
}

/**
 * Computes the minimal `Op[]` for the cells that changed between two snapshots (contracts section 4.2).
 * Emits `{ ns, key, val }` for each added/updated cell and `{ ns, key, val: null }` for each deleted
 * cell; an unchanged namespace contributes no ops. O(changed-keys) — the unit of the throttled delta.
 *
 * @param previous - The previous snapshot (last broadcast baseline).
 * @param next - The next snapshot (current authoritative state).
 * @throws {Error} Always — skeleton stub.
 * @example
 * ```ts
 * const ops = diffToOps({ scores: { p1: 0 } }, { scores: { p1: 10 } });
 * // [{ ns: "scores", key: "p1", val: 10 }]
 * ```
 */
export function diffToOps(previous: Snapshot, next: Snapshot): readonly Op[] {
  throw new Error("not implemented");
}

/**
 * Applies an `Op[]` patch to a snapshot, returning the next snapshot (contracts section 4.2). The inverse
 * of {@link diffToOps} + broadcast: `applyOps(prev, diffToOps(prev, next))` deep-equals `next`. `val: null`
 * deletes the cell. Pure — returns a new snapshot, never mutates `prev`.
 *
 * @param snapshot - The snapshot to patch (the controller replica or the host baseline).
 * @param ops - The ordered `Op[]` to apply.
 * @throws {Error} Always — skeleton stub.
 * @example
 * ```ts
 * const next = applyOps({ scores: { p1: 0 } }, [{ ns: "scores", key: "p1", val: 10 }]);
 * // { scores: { p1: 10 } }
 * ```
 */
export function applyOps(snapshot: Snapshot, ops: readonly Op[]): Snapshot {
  throw new Error("not implemented");
}

/**
 * Builds the `Op[]` that encodes one namespace's full cell set (used when forcing a per-namespace baseline
 * within a delta rather than a whole-snapshot frame). Every cell becomes an `{ ns, key, val }` op.
 *
 * @param ns - The namespace whose cells to encode.
 * @param cells - The namespace's current plain-JSON cells.
 * @throws {Error} Always — skeleton stub.
 * @example
 * ```ts
 * const ops = encodeNamespace("scores", { p1: 10, p2: 0 });
 * ```
 */
export function encodeNamespace(ns: Namespace, cells: Cells): readonly Op[] {
  throw new Error("not implemented");
}
