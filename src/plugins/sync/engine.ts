/**
 * @file The per-app `SyncEngine` implementation for `syncPlugin`.
 * @see README.md
 *
 * Built EXACTLY ONCE per app in `index.ts`'s `api` over THIS app's `ctx.state`/`ctx.config`/`Wire`/
 * `SessionApi`/`emit`, then shared via `ctx.state.engine`. Owns the slice registry, the per-namespace
 * dirty-flag, the 20-30 Hz throttle broadcast loop (timer id stored in `state.throttleHandle`), the
 * read-only replica apply path with `sSeq` gap detection, the per-namespace `subscribe` callback `Map`
 * (a closure-scope `Map` — kept OUT of `State` so `State.snapshot` stays plain-JSON), and the single
 * `room:sync-ready` emit. Pure codec work delegates to `codec.ts`. All wire I/O rides the injected `Wire`
 * (contracts section 2) — NEVER Moku `emit` (only `room:sync-ready` rides `emit`). Shared contract types
 * are imported from `../../contracts` (D16); `SessionApi` from the owning `session` plugin.
 */
import type { Frame, Namespace, Op, PeerId, Snapshot } from "../../contracts";
import type { SessionApi } from "../session/types";
import { applyOps, decodeSnapshot, encodeNamespace, encodeSnapshot } from "./codec";
import type { Cells, Config, State, SyncEngine } from "./types";

/**
 * The narrowed `emit` the engine needs — a zero-arg closure that signals the single event this plugin
 * owns (`room:sync-ready`, contracts section 3.1). The wiring harness binds it inline in `index.ts` as
 * `() => ctx.emit("room:sync-ready", {})`, so the engine never imports the framework `EmitFunction` (the
 * empty `{}` payload is supplied at the bind site, conventions section 3).
 */
type SyncReadyEmit = () => void;

/** Error message prefix for [room] formatted errors (spec/11 Part 3; matches the `room:` event namespace). */
const ERROR_PREFIX = "[room]";

/**
 * Builds the ONE per-app `SyncEngine` over this app's mutable state, config, transport `Wire`, session
 * roster, and a narrowed `emit`. A LOCAL factory bound to the passed `ctx` members — NOT a module-level
 * singleton — so each composed app (the `inMemory` stage + N controllers) gets its own engine and its own
 * `subscribe` callback `Map`. Building once and sharing via `ctx.state.engine` is mandatory for
 * correctness: consumer subscriptions and inbound-frame application MUST hit the SAME engine/`Map`.
 *
 * @param state - This app's mutable `syncPlugin` state (`ctx.state`).
 * @param config - This app's frozen `syncPlugin` config (`ctx.config`).
 * @param wire - The transport `Wire` obtained via `ctx.require(transportPlugin).wire()` (contracts section 2).
 * @param wire.send - Sends a single frame to one peer.
 * @param wire.broadcast - Broadcasts a single frame to every connected peer.
 * @param wire.on - Registers the inbound-frame handler; returns an unsubscribe.
 * @param session - The `SessionApi` from `ctx.require(sessionPlugin)` (roster/`PeerId` access).
 * @param emit - The narrowed zero-arg `emit` closure that signals `room:sync-ready` (bound in `index.ts`).
 * @returns A fully-wired `SyncEngine` bound to this app's state, config, wire, and emit.
 * @example
 * ```ts
 * const engine = createSyncEngine(state, config, wire, session, () => emit("room:sync-ready", {}));
 * state.engine = engine;
 * ```
 */
export function createSyncEngine(
  state: State,
  config: Readonly<Config>,
  wire: {
    send(peerId: PeerId, frame: Frame): void;
    broadcast(frame: Frame): void;
    on(handler: (peerId: PeerId, frame: Frame) => void): () => void;
  },
  session: SessionApi,
  emit: SyncReadyEmit
): SyncEngine {
  // Per-namespace subscribe callback registry. Closure-scope (NOT in State) so State.snapshot
  // stays plain-JSON. Each ns maps to an array of active subscriber functions.
  const subscribers = new Map<Namespace, Array<(cells: Cells) => void>>();

  // Registry tracking which namespaces have been registered via registerSlice.
  // Stores the initial JSON string for idempotence checking.
  const registered = new Map<Namespace, string>();

  // Per-namespace onResyncRequest handlers (host-side gap notification).
  const resyncHandlers: Array<(peerId: PeerId) => void> = [];

  /**
   * Notify a namespace's subscribers with its current cells (frozen copy, never a live reference).
   *
   * @param ns - The namespace whose subscribers to notify.
   * @param cells - The namespace's current cells; frozen + cloned before delivery.
   * @example
   * ```ts
   * notifySubscribers("scores", state.snapshot.scores);
   * ```
   */
  function notifySubscribers(ns: Namespace, cells: Cells): void {
    const subs = subscribers.get(ns);
    if (!subs) {
      return;
    }
    // Frozen copy — not a live reference (spec/11 §2.4)
    const frozen = Object.freeze(structuredClone(cells) as Cells);
    for (const cb of subs) {
      cb(frozen);
    }
  }

  /**
   * Flip `ready` on the first applied authoritative frame (a snapshot, or a gap-free delta from the
   * initial state) and emit `room:sync-ready` exactly once.
   *
   * @example
   * ```ts
   * markReady(); // first call sets state.ready + emits; later calls are no-ops
   * ```
   */
  function markReady(): void {
    if (!state.ready) {
      state.ready = true;
      emit();
    }
  }

  /**
   * Broadcast a delta of all dirty namespaces; clears the dirty flag and bumps `sSeq`.
   *
   * @returns The number of delta frames sent (0 when nothing was dirty and `skipEmptyDeltas` is on).
   * @example
   * ```ts
   * const frames = broadcastDirty();
   * ```
   */
  function broadcastDirty(): number {
    const dirtyNs = Object.keys(state.dirty);
    if (dirtyNs.length === 0) {
      if (config.skipEmptyDeltas) {
        return 0;
      }
      // Heartbeat-style: send empty delta
      state.sSeq += 1;
      wire.broadcast({ t: "sync-delta", ops: [], sSeq: state.sSeq });
      session.persistSnapshot(encodeSnapshot(state.snapshot), state.sSeq);
      return 1;
    }

    // Build ops for all dirty namespaces
    const allOps = dirtyNs.flatMap(ns => {
      const cells = state.snapshot[ns];
      if (!cells) {
        return [];
      }
      return encodeNamespace(ns, cells);
    });

    // Clear dirty before bumping sSeq
    state.dirty = {};

    // Batch ops respecting maxOpsPerDelta cap
    const maxOps = config.maxOpsPerDelta > 0 ? config.maxOpsPerDelta : allOps.length;
    let frameCount = 0;

    for (let index = 0; index < allOps.length; index += maxOps) {
      const batch = allOps.slice(index, index + maxOps);
      state.sSeq += 1;
      wire.broadcast({ t: "sync-delta", ops: batch, sSeq: state.sSeq });
      frameCount++;
    }

    // Persist snapshot after all delta frames for this tick
    session.persistSnapshot(encodeSnapshot(state.snapshot), state.sSeq);

    return frameCount;
  }

  /**
   * Re-baselines the replica from a whole-state `sync-snap` frame (controller apply path; contracts §4.3).
   * Replaces the snapshot, adopts the frame's `sSeq`, clears any `stale` flag (a fresh snapshot always
   * resolves a gap), emits `room:sync-ready` on the first applied snapshot, and notifies every namespace's
   * subscribers so the replica re-renders.
   *
   * @param snapshot - The authoritative whole-state `Snapshot` carried by the `sync-snap` frame.
   * @param sSeq - The host sequence the snapshot represents; becomes the new replica baseline.
   * @example
   * ```ts
   * applySnapshotFrame({ scores: { p1: 10 } }, 5); // replica now mirrors the host at sSeq 5
   * ```
   */
  function applySnapshotFrame(snapshot: Snapshot, sSeq: number): void {
    state.snapshot = decodeSnapshot(snapshot);
    state.sSeq = sSeq;
    state.stale = false; // a fresh whole-state snapshot always clears a prior gap
    markReady();
    for (const ns of Object.keys(state.snapshot)) {
      const cells = state.snapshot[ns];
      if (cells) {
        notifySubscribers(ns, cells);
      }
    }
  }

  /**
   * Applies an ordered `sync-delta` frame to the replica (controller apply path; contracts §4.3). Drops
   * the frame while `stale` (awaiting a re-baseline). Detects a sequence gap (`sSeq > local sSeq + 1`):
   * marks `stale`, fires the `onResyncRequest` hooks when `resyncOnGap` is on (with an empty `peerId` — the
   * controller has no peer context here), and skips the apply. Ignores an already-seen `sSeq`. On a
   * contiguous frame it applies the ops, adopts `sSeq`, flips `ready` on the first such frame (a controller
   * that joined before any slice existed bootstraps off this delta), and notifies the subscribers of every
   * touched namespace.
   *
   * @param ops - The ordered `Op[]` carried by the `sync-delta` frame.
   * @param sSeq - The host sequence the delta represents (gap-checked against the local `sSeq`).
   * @example
   * ```ts
   * applyDeltaFrame([{ ns: "scores", key: "p1", val: 10 }], 1); // contiguous → applied
   * ```
   */
  function applyDeltaFrame(ops: readonly Op[], sSeq: number): void {
    if (state.stale) {
      return; // ignore deltas until a fresh snapshot clears the gap
    }
    // Sequence gap — cannot apply out of order; mark stale and request a fresh snapshot.
    if (sSeq > state.sSeq + 1) {
      state.stale = true;
      if (config.resyncOnGap) {
        for (const handler of resyncHandlers) {
          handler("");
        }
      }
      return;
    }
    // Already-applied / duplicate frame — idempotent no-op.
    if (sSeq <= state.sSeq) {
      return;
    }
    // Contiguous frame — apply in order, adopt sSeq, and notify affected namespaces.
    const affected = new Set(ops.map(op => op.ns));
    state.snapshot = applyOps(state.snapshot, ops);
    state.sSeq = sSeq;
    // First gap-free authoritative frame makes the replica readable (a controller that joined BEFORE a
    // slice was registered bootstraps off this delta, never a snapshot — §4.3). Idempotent.
    markReady();
    for (const ns of affected) {
      const cells = state.snapshot[ns];
      if (cells) {
        notifySubscribers(ns, cells);
      }
    }
  }

  /* eslint-disable jsdoc/require-jsdoc -- thin object-literal SyncEngine implementations; each method's contract is documented on the SyncEngine type in types.ts */
  const engine: SyncEngine = {
    init() {
      // Clamp broadcastHz to [5, 60]
      const hz = config.broadcastHz;
      if (hz < 5 || hz > 60) {
        throw new Error(
          `${ERROR_PREFIX} sync.broadcastHz must be between 5 and 60 (got ${hz}).\n  Set a value in pluginConfigs.sync.broadcastHz.`
        );
      }
      if (config.maxOpsPerDelta < 0) {
        throw new Error(
          `${ERROR_PREFIX} sync.maxOpsPerDelta must be >= 0 (got ${config.maxOpsPerDelta}).\n  Set a non-negative value in pluginConfigs.sync.maxOpsPerDelta.`
        );
      }

      // Wire the inbound frame route — routes sync-snap/sync-delta only → applyFrame
      wire.on((_peerId, frame) => {
        if (frame.t === "sync-snap" || frame.t === "sync-delta") {
          engine.applyFrame(frame);
        }
      });
    },

    registerSlice(ns: Namespace, initial: Cells): void {
      const initialJson = JSON.stringify(initial);
      const existing = registered.get(ns);

      if (existing !== undefined) {
        // Idempotent: same initial is a no-op
        if (existing === initialJson) {
          return;
        }
        // Different initial: throw
        throw new Error(
          `${ERROR_PREFIX} sync.registerSlice: namespace "${ns}" is already registered with a different initial value.\n  Call registerSlice once per namespace per session.`
        );
      }

      registered.set(ns, initialJson);

      // Set initial state in snapshot (clone to avoid external mutation)
      state.snapshot = {
        ...state.snapshot,
        [ns]: structuredClone(initial) as Cells
      };

      // Mark ready after first slice registration on host (the host role path)
      markReady();
    },

    mutate(ns: Namespace, recipe: (draft: Cells) => Cells): void {
      if (!registered.has(ns)) {
        throw new Error(
          `${ERROR_PREFIX} sync.mutate: namespace "${ns}" is not registered.\n  Call registerSlice("${ns}", initial) before mutating.`
        );
      }

      const current = state.snapshot[ns] ?? {};
      const next = recipe(current);

      // Only mark dirty if something actually changed
      if (JSON.stringify(current) !== JSON.stringify(next)) {
        state.snapshot = { ...state.snapshot, [ns]: next };
        state.dirty = { ...state.dirty, [ns]: true };
      }
    },

    broadcast(peerId?: PeerId): void {
      if (peerId === undefined) {
        // Delta broadcast to everyone
        broadcastDirty();
      } else {
        // Single-peer full snapshot (late-join / reconcile)
        state.sSeq += 1;
        wire.send(peerId, {
          t: "sync-snap",
          snapshot: encodeSnapshot(state.snapshot),
          sSeq: state.sSeq
        });
        session.persistSnapshot(encodeSnapshot(state.snapshot), state.sSeq);
      }
    },

    sendBaselineSnapshot(peerId: PeerId): void {
      // No-op if no slices registered
      if (registered.size === 0) {
        return;
      }
      // Send full snapshot without bumping sSeq (baseline for late-joiner)
      wire.send(peerId, {
        t: "sync-snap",
        snapshot: encodeSnapshot(state.snapshot),
        sSeq: state.sSeq
      });
    },

    onResyncRequest(handler: (peerId: PeerId) => void): () => void {
      resyncHandlers.push(handler);
      return () => {
        const index = resyncHandlers.indexOf(handler);
        if (index !== -1) {
          resyncHandlers.splice(index, 1);
        }
      };
    },

    read(ns: Namespace): Cells | undefined {
      const cells = state.snapshot[ns];
      if (!cells) {
        return undefined;
      }
      // Return a frozen copy — never a live reference (spec/11 §2.4)
      return Object.freeze(structuredClone(cells) as Cells);
    },

    subscribe(ns: Namespace, cb: (cells: Cells) => void): () => void {
      if (!subscribers.has(ns)) {
        subscribers.set(ns, []);
      }
      const subs = subscribers.get(ns);
      if (!subs) {
        return () => {};
      }
      subs.push(cb);

      // Fire immediately if namespace is already present
      const cells = state.snapshot[ns];
      if (cells) {
        const frozen = Object.freeze(structuredClone(cells) as Cells);
        cb(frozen);
      }

      return () => {
        const list = subscribers.get(ns);
        if (!list) {
          return;
        }
        const index = list.indexOf(cb);
        if (index !== -1) {
          list.splice(index, 1);
        }
      };
    },

    /**
     * Applies one inbound host frame to the replica. Routes to the snapshot or delta apply path based
     * on `frame.t`; non-sync frames are silently ignored (transport routes by `t`, defensive guard).
     * A `sync-snap` re-baselines the entire replica; a `sync-delta` applies ops in order or sets
     * `stale` on a detected sequence gap. The first applied snapshot triggers `room:sync-ready`.
     *
     * @param frame - The inbound `Frame` (contracts section 2.2); only `sync-snap`/`sync-delta` act.
     * @example
     * ```ts
     * wire.on((_, frame) => engine.applyFrame(frame));
     * ```
     */
    applyFrame(frame: Frame): void {
      if (frame.t === "sync-snap") {
        applySnapshotFrame(frame.snapshot, frame.sSeq);
      } else if (frame.t === "sync-delta") {
        applyDeltaFrame(frame.ops, frame.sSeq);
      }
      // Non-sync frames: ignored (defensive — transport routes by `t`)
    },

    isReady(): boolean {
      return state.ready;
    },

    exportSnapshot(): { readonly snapshot: Snapshot; readonly sSeq: number } {
      return {
        snapshot: encodeSnapshot(state.snapshot),
        sSeq: state.sSeq
      };
    },

    importSnapshot(snapshot: Snapshot, sSeq: number): void {
      state.snapshot = decodeSnapshot(snapshot);
      state.sSeq = sSeq;

      // Register all restored namespaces
      for (const ns of Object.keys(state.snapshot)) {
        const cells = state.snapshot[ns];
        if (cells && !registered.has(ns)) {
          registered.set(ns, JSON.stringify(cells));
        }
      }

      // Flip ready (host re-entry)
      markReady();
    },

    startBroadcast(): void {
      if (state.broadcasting) {
        return; // Idempotent
      }
      state.broadcasting = true;

      const intervalMs = Math.round(1000 / config.broadcastHz);
      state.throttleHandle = setInterval(() => {
        broadcastDirty();
      }, intervalMs);
    },

    stopBroadcast(): void {
      if (!state.broadcasting && state.throttleHandle === null) {
        return; // Idempotent
      }
      if (state.throttleHandle !== null) {
        clearInterval(state.throttleHandle as ReturnType<typeof setInterval>);
        state.throttleHandle = null;
      }
      state.broadcasting = false;
    }
  };
  /* eslint-enable jsdoc/require-jsdoc */

  return engine;
}
