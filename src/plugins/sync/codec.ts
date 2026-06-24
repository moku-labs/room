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
import type { JsonValue, Namespace, Op, Snapshot } from "../../contracts";
import type { Cells } from "./types";

/**
 * The mutable working shape used while applying ops: a `Snapshot` (contracts section 4.1) with its
 * `readonly` modifiers dropped so cells can be set/deleted in place before the result is returned as a
 * `Snapshot`. Namespace → (key → {@link JsonValue}), matching the `Snapshot`/`Op.val` cell contract.
 */
type MutableSnapshot = Record<string, Record<string, JsonValue>>;

/**
 * Serializes a whole `Snapshot` to the exact plain-JSON byte shape `sessionPlugin` persists and the host
 * sends in a `SyncSnapshotFrame` (contracts section 4.1, section 5.1). Deep-clones to a structurally-frozen,
 * `JSON.stringify`-safe value — never a live reference into engine state.
 *
 * @param snapshot - The authoritative `Snapshot` to encode.
 * @returns A deep-cloned, plain-JSON snapshot safe for serialization and persistence.
 * @example
 * ```ts
 * const bytes = encodeSnapshot(state.snapshot);
 * ```
 */
export function encodeSnapshot(snapshot: Snapshot): Snapshot {
  return structuredClone(snapshot) as Snapshot;
}

/**
 * Deserializes a received/persisted `Snapshot` back into engine state shape (contracts section 4.1). The
 * inverse of {@link encodeSnapshot}; deep-equal round-trips for any plain-JSON input.
 *
 * @param snapshot - The plain-JSON `Snapshot` to decode.
 * @returns A deep-cloned snapshot ready for the engine's internal use.
 * @example
 * ```ts
 * const restored = decodeSnapshot(JSON.parse(persisted));
 * ```
 */
export function decodeSnapshot(snapshot: Snapshot): Snapshot {
  return structuredClone(snapshot) as Snapshot;
}

/**
 * Emits ops for cells added or updated within a namespace that exists in the next snapshot.
 * Mutates `ops` in place. Separated from delete detection to keep each concern small.
 *
 * @param ns - The namespace key.
 * @param previousCells - The cells that were present before.
 * @param nextCells - The cells that are present now.
 * @param ops - The accumulator array to push ops into.
 * @example
 * ```ts
 * diffNamespaceCells("scores", { p1: 0 }, { p1: 10 }, ops); // pushes { ns: "scores", key: "p1", val: 10 }
 * ```
 */
function diffNamespaceCells(
  ns: Namespace,
  previousCells: Cells,
  nextCells: Cells,
  ops: Op[]
): void {
  // Added or updated cells
  for (const key of Object.keys(nextCells)) {
    const previousValue = previousCells[key];
    const nextValue = nextCells[key];
    if (JSON.stringify(previousValue) !== JSON.stringify(nextValue)) {
      ops.push({ ns, key, val: nextValue ?? null });
    }
  }

  // Deleted cells (exist in previous but absent in next)
  for (const key of Object.keys(previousCells)) {
    if (!(key in nextCells)) {
      ops.push({ ns, key, val: null });
    }
  }
}

/**
 * Emits `{ val: null }` delete ops for all cells in a namespace that was removed entirely from the
 * next snapshot. Only called for namespaces present in `previous` but absent in `next`.
 *
 * @param ns - The removed namespace key.
 * @param previousCells - The cells that were present in the removed namespace.
 * @param ops - The accumulator array to push ops into.
 * @example
 * ```ts
 * diffRemovedNamespace("scores", { p1: 0, p2: 1 }, ops); // pushes a delete op per removed cell
 * ```
 */
function diffRemovedNamespace(
  ns: Namespace,
  previousCells: Readonly<Record<string, unknown>>,
  ops: Op[]
): void {
  for (const key of Object.keys(previousCells)) {
    ops.push({ ns, key, val: null });
  }
}

/**
 * Computes the minimal `Op[]` for the cells that changed between two snapshots (contracts section 4.2).
 * Emits `{ ns, key, val }` for each added/updated cell and `{ ns, key, val: null }` for each deleted
 * cell; an unchanged namespace contributes no ops. O(changed-keys) — the unit of the throttled delta.
 *
 * @param previous - The previous snapshot (last broadcast baseline).
 * @param next - The next snapshot (current authoritative state).
 * @returns A minimal `Op[]` representing only the cells that changed.
 * @example
 * ```ts
 * const ops = diffToOps({ scores: { p1: 0 } }, { scores: { p1: 10 } });
 * // [{ ns: "scores", key: "p1", val: 10 }]
 * ```
 */
export function diffToOps(previous: Snapshot, next: Snapshot): readonly Op[] {
  const ops: Op[] = [];

  // Pass 1: namespaces present in `next` — added/updated/deleted cells within them
  for (const ns of Object.keys(next)) {
    const nextCells = next[ns];
    if (!nextCells) {
      continue;
    }
    diffNamespaceCells(ns, previous[ns] ?? {}, nextCells, ops);
  }

  // Pass 2: namespaces that existed in `previous` but are fully absent in `next`
  for (const ns of Object.keys(previous)) {
    if (ns in next) {
      continue;
    }
    const previousCells = previous[ns];
    if (previousCells) {
      diffRemovedNamespace(ns, previousCells, ops);
    }
  }

  return ops;
}

/**
 * Applies an `Op[]` patch to a snapshot, returning the next snapshot (contracts section 4.2). The inverse
 * of {@link diffToOps} + broadcast: `applyOps(prev, diffToOps(prev, next))` deep-equals `next`. `val: null`
 * deletes the cell. Pure — returns a new snapshot, never mutates `prev`.
 *
 * @param snapshot - The snapshot to patch (the controller replica or the host baseline).
 * @param ops - The ordered `Op[]` to apply.
 * @returns A new snapshot with the ops applied; `val: null` deletes the keyed cell.
 * @example
 * ```ts
 * const next = applyOps({ scores: { p1: 0 } }, [{ ns: "scores", key: "p1", val: 10 }]);
 * // { scores: { p1: 10 } }
 * ```
 */
export function applyOps(snapshot: Snapshot, ops: readonly Op[]): Snapshot {
  if (ops.length === 0) {
    return snapshot;
  }

  // Build a mutable working copy of the snapshot namespaces
  const result: MutableSnapshot = {};
  for (const ns of Object.keys(snapshot)) {
    result[ns] = { ...snapshot[ns] };
  }

  // Apply each op in order: a null val deletes the cell, any other value sets it.
  for (const op of ops) {
    const { ns, key, val } = op;
    if (!(ns in result)) {
      result[ns] = {};
    }
    const nsCells = result[ns];
    if (!nsCells) {
      continue;
    }
    if (val === null) {
      delete nsCells[key];
    } else {
      nsCells[key] = val;
    }
  }

  // Remove any namespaces that became empty due to deletes
  for (const ns of Object.keys(result)) {
    const nsCells = result[ns];
    if (nsCells && Object.keys(nsCells).length === 0) {
      delete result[ns];
    }
  }

  return result as Snapshot;
}

/**
 * Builds the `Op[]` that encodes one namespace's full cell set (used when forcing a per-namespace baseline
 * within a delta rather than a whole-snapshot frame). Every cell becomes an `{ ns, key, val }` op.
 *
 * @param ns - The namespace whose cells to encode.
 * @param cells - The namespace's current plain-JSON cells.
 * @returns An `Op[]` with one entry per cell in the namespace.
 * @example
 * ```ts
 * const ops = encodeNamespace("scores", { p1: 10, p2: 0 });
 * ```
 */
export function encodeNamespace(ns: Namespace, cells: Cells): readonly Op[] {
  return Object.keys(cells).map(key => ({ ns, key, val: cells[key] ?? null }));
}
