/**
 * @file Typed default config for `transportPlugin` (R6 — no inline `as` in the `createPlugin` spec).
 * @see README.md
 *
 * `DEFAULT_TRANSPORT_CONFIG` is the typed default factory result. `signaling` defaults to
 * `publicRendezvous()`; `iceServers` to a single public STUN; timings per spec. Keeping this a typed
 * const keeps the `createPlugin` spec object free of inline assertions (contracts invariant checklist).
 */
import { publicRendezvous } from "./adapter";
import type { TransportConfig } from "./types";

/**
 * Default ICE servers — a single public STUN. Typed `const` so no inline `as` appears in the config
 * object (R6). Override to `[]` for LAN-only; never TURN (D2).
 */
const DEFAULT_ICE_SERVERS: readonly RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

/** Default heartbeat ping interval in ms (contracts section 2.4; D11). */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 2000;

/** Default dead-peer timeout in ms (contracts section 2.4; WebKit bug 303052). */
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 6000;

/** Default DataChannel-open timeout in ms before a handshake retry (the interop GATE mitigation). */
const DEFAULT_OPEN_TIMEOUT_MS = 3000;

/** Default chunk threshold in bytes (~14 KiB; contracts section 2.3). */
const DEFAULT_MAX_MESSAGE_BYTES = 14_336;

/**
 * The typed default `transportPlugin` config. `signaling` defaults to `publicRendezvous()` (D11/D12);
 * every timing is overridable so the iOS-to-Bravia interop spike can tune per real-device results.
 *
 * @example
 * ```ts
 * const cfg = DEFAULT_TRANSPORT_CONFIG;
 * cfg.heartbeatIntervalMs; // 2000
 * ```
 */
export const DEFAULT_TRANSPORT_CONFIG: TransportConfig = {
  signaling: publicRendezvous(),
  iceServers: DEFAULT_ICE_SERVERS,
  heartbeatIntervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS,
  heartbeatTimeoutMs: DEFAULT_HEARTBEAT_TIMEOUT_MS,
  openTimeoutMs: DEFAULT_OPEN_TIMEOUT_MS,
  maxMessageBytes: DEFAULT_MAX_MESSAGE_BYTES
};
