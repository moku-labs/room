/**
 * @file Reconnect-timeout + iOS degradation (§5.4, D11 v1 GATE). Arms the `reconnectTimeoutMs` timer when
 * the host goes absent; on expiry an iOS (WebKit) controller flips `recovery.phase` to `"degraded"` and
 * surfaces "rescan the QR to rejoin" (WebKit `RTCPeerConnection`-after-disappear bug, Trystero #29/#30),
 * while non-WebKit controllers may auto-rejoin first. The UA gate reads `navigator.userAgent` behind a DOM
 * guard (the exact accessor is pinned during the build wave).
 * @see ../README.md
 */

import type { SessionDeps } from "../types";
import { rejoinSameRoom } from "./reentry";

/**
 * Detects whether the current UA is iOS/WebKit (Trystero #29/#30 bug surface). Guards `navigator` access
 * behind a DOM check so headless/Bun tests see `false`.
 *
 * @returns `true` if running on an iOS/WebKit UA.
 * @example
 * ```ts
 * if (isIosWebKit()) { /* degrade immediately *\/ }
 * ```
 */
function isIosWebKit(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iP(hone|ad|od)|iPhone OS|iPad OS/.test(navigator.userAgent);
}

/**
 * Arms the `reconnectTimeoutMs` countdown when the host channel is lost (§5.4). Stores the `TimerHandle`
 * into `deps.state.recovery.timer` and sets `reconnectDeadline`. On expiry, runs {@link degradeOrRejoin}.
 *
 * @param deps - This app's destructured per-instance pieces.
 * @example
 * ```ts
 * armReconnectTimeout(deps); // called from handleHostChannelLost
 * ```
 */
export function armReconnectTimeout(deps: SessionDeps): void {
  // Clear any pre-existing timer before arming a new one.
  if (deps.state.recovery.timer !== null) {
    clearTimeout(deps.state.recovery.timer);
  }
  deps.state.recovery.reconnectDeadline = Date.now() + deps.config.reconnectTimeoutMs;
  deps.state.recovery.timer = setTimeout(() => {
    deps.state.recovery.timer = null;
    void degradeOrRejoin(deps);
  }, deps.config.reconnectTimeoutMs);
}

/**
 * Timeout-expiry decision (§5.4). On a WebKit/iOS UA (read via a DOM-guarded `navigator.userAgent`) flips `recovery.phase` to
 * `"degraded"` and surfaces the "rescan QR" path; on a non-WebKit UA, attempts an auto-rejoin first and
 * only degrades if that fails. Clears the reconnect timer either way.
 *
 * @param deps - This app's destructured per-instance pieces.
 * @returns A promise that resolves when the decision (degrade or rejoin attempt) is complete.
 * @example
 * ```ts
 * await degradeOrRejoin(deps);
 * ```
 */
export async function degradeOrRejoin(deps: SessionDeps): Promise<void> {
  // Clear any in-flight timer handle.
  if (deps.state.recovery.timer !== null) {
    clearTimeout(deps.state.recovery.timer);
    deps.state.recovery.timer = null;
  }

  if (isIosWebKit()) {
    // iOS/WebKit: degrade immediately — WebKit cannot re-establish a dead RTCPeerConnection.
    deps.state.recovery.phase = "degraded";
    return;
  }

  // Non-iOS: attempt auto-rejoin first.
  try {
    const result = await rejoinSameRoom(deps);
    if (!result.ok) {
      // Rejoin failed — degrade.
      deps.state.recovery.phase = "degraded";
    }
    // On success, rejoinSameRoom already updated the phase.
  } catch {
    deps.state.recovery.phase = "degraded";
  }
}
