/**
 * @file Opaque INTERNAL handle types for the recovery sub-domain. NOT part of the public API, NOT in
 * `00-contracts.md`, and never crossing the §2 wire. `TimerHandle` mirrors `setTimeout`'s return;
 * `PersistHandle` is the debounced-persistence driver's control surface (with `PersistHandleInternal`
 * adding the package-internal `_update`). All are stored inside `ctx.state.recovery` and reached by
 * `onStop` via the `teardownRegistry` WeakMap (D14).
 * @see ../README.md
 */

import type { HostReentryRecord } from "../types";

/** Runtime-only timer handle — the return of `setTimeout`. Never persisted, never sent over §2. */
export type TimerHandle = ReturnType<typeof setTimeout>;

/**
 * Control surface for the debounced host-snapshot persistence driver (IndexedDB + the synchronous
 * `localStorage`-on-`visibilitychange` write). Stored in `ctx.state.recovery.persistHandle`; `onStop`
 * calls `flushNow()` then `dispose()` after looking it up in the `teardownRegistry` WeakMap (D14).
 */
export type PersistHandle = {
  /** Synchronously writes the latest `HostReentryRecord` to localStorage (the `visibilitychange`/`onStop` path). */
  flushNow(): void;
  /** Clears the debounce timer and removes the `visibilitychange` listener the driver registered. */
  dispose(): void;
};

/**
 * Internal extension of {@link PersistHandle} that adds the record updater used by `recordSnapshot`.
 * `_update` is a package-internal detail — NOT part of the public `PersistHandle` surface. Stored in
 * `ctx.state.recovery.persistHandle`, so the field is typed as this wider internal shape.
 */
export type PersistHandleInternal = PersistHandle & {
  /**
   * Updates the retained latest record and optionally schedules the debounced IndexedDB write.
   *
   * @param record - The new latest `HostReentryRecord`.
   * @param scheduleIdb - Whether to (re)schedule the debounced durable write.
   * @example
   * ```ts
   * (handle as PersistHandleInternal)._update(record, true);
   * ```
   */
  _update(record: HostReentryRecord, scheduleIdb: boolean): void;
};
