/**
 * @file Reconnect-timeout + iOS degradation (§5.4, D11 v1 GATE). Arms the `reconnectTimeoutMs` timer when
 * the host goes absent; on expiry an iOS (WebKit) controller flips `recovery.phase` to `"degraded"` and
 * surfaces "rescan the QR to rejoin" (WebKit `RTCPeerConnection`-after-disappear bug, Trystero #29/#30),
 * while non-WebKit controllers may auto-rejoin first. The UA gate reads `navigator.userAgent` behind a DOM
 * guard (the exact accessor is pinned during the build wave).
 * @see ../README.md
 */

import type { SessionDeps } from "../types";

/**
 * Arms the `reconnectTimeoutMs` countdown when the host channel is lost (§5.4). Stores the `TimerHandle`
 * into `deps.state.recovery.timer` and sets `reconnectDeadline`. On expiry, runs {@link degradeOrRejoin}.
 *
 * @param deps - This app's destructured per-instance pieces.
 * @throws {Error} Always — skeleton stub.
 * @example
 * ```ts
 * armReconnectTimeout(deps); // called from handleHostChannelLost
 * ```
 */
export function armReconnectTimeout(deps: SessionDeps): void {
  throw new Error("not implemented");
}

/**
 * Timeout-expiry decision (§5.4). On a WebKit/iOS UA (read via a DOM-guarded `navigator.userAgent`) flips `recovery.phase` to
 * `"degraded"` and surfaces the "rescan QR" path; on a non-WebKit UA, attempts an auto-rejoin first and
 * only degrades if that fails. Clears the reconnect timer either way.
 *
 * @param deps - This app's destructured per-instance pieces.
 * @throws {Error} Always — skeleton stub.
 * @example
 * ```ts
 * await degradeOrRejoin(deps);
 * ```
 */
export function degradeOrRejoin(deps: SessionDeps): Promise<void> {
  throw new Error("not implemented");
}
