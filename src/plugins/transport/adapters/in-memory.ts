/**
 * @file The `inMemory` signaling adapter — a deterministic in-process bus for tests (D12). DOM-free; no
 * `RTCPeerConnection`. Two sessions on the same `code` mutually fire `onPeer` and deliver `SignalMsg`s
 * in-process. Pulls in ZERO Trystero.
 * @see ../README.md
 */
import type { Signaling } from "../adapter";

/**
 * Creates an in-process `Signaling` adapter (contracts section 1). Sessions joined on the same `code`
 * share one in-memory bus: each fires the other's `onPeer`, and `send` delivers `SignalMsg`s synchronously
 * to the recipient's `onSignal`. `leave()` is idempotent. Used by `tests/integration/` for a deterministic
 * transport with no real WebRTC (the DOM-free contract proof, D12).
 *
 * @example
 * ```ts
 * const sig = inMemory();
 * const host = await sig.join("K7M2QX", { selfId: "host_root" });
 * const ctrl = await sig.join("K7M2QX", { selfId: "p_ab12", passive: true });
 * ```
 */
export function inMemory(): Signaling {
  throw new Error("not implemented");
}
