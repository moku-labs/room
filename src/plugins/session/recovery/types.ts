/**
 * @file Opaque INTERNAL handle types for the recovery sub-domain. NOT part of the public API, NOT in
 * `00-contracts.md`, and never crossing the §2 wire. `TimerHandle` mirrors `setTimeout`'s return;
 * `PersistHandle` is the debounced-persistence driver's control surface. Both are stored inside
 * `ctx.state.recovery` and reached by `onStop` via the `teardownRegistry` WeakMap (D14).
 * @see ../README.md
 */

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
