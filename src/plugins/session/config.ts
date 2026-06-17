/**
 * @file Typed default config for `sessionPlugin` (keeps the `index.ts` wiring harness free of inline `as`).
 * `sessionConfig` encodes the D11 / contracts §5 verified constants; the three owned `room:*` event
 * descriptions live inline in the `index.ts` `events` register-map.
 * @see README.md
 */

import type { SessionConfig } from "./types";

/**
 * The typed default `sessionPlugin` config. Every field is overridable via
 * `createApp({ pluginConfigs: { session: { ... } } })`; the defaults encode the D11 / contracts §5
 * constants (8-cap, 500 ms snapshot debounce, 10 s reconnect window, 256-entry / 8 s intent buffer).
 *
 * @example
 * ```ts
 * const cfg = sessionConfig;
 * cfg.reconnectTimeoutMs; // 10_000
 * ```
 */
export const sessionConfig: SessionConfig = {
  joinUrlBase: "",
  generateQr: true,
  maxControllers: 8, // MAX_CONTROLLERS (§6.1)
  snapshotDebounceMs: 500,
  reconnectTimeoutMs: 10_000,
  intentBufferMax: 256,
  intentBufferMaxAgeMs: 8000,
  storageKeyPrefix: "moku.room"
};
