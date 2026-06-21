/**
 * @file transport/adapters/server.ts — opt-in server-backed Signaling adapter (D21/D25).
 * @see ../../../contracts
 */
// Skeleton stub uses only `Signaling`. The build wave restores ClientEnvelope, ServerEnvelope,
// SignalingSession, SignalingJoinOpts, SignalMsg, PeerId when implementing the join() body.
import type { Signaling } from "../../../contracts";

/**
 * Builds an opt-in {@link Signaling} adapter backed by a Moku Worker room-hub. One persistent WebSocket
 * per `join(code)`; the returned session sets `persistent: true` so transport keeps it open post-ICE.
 *
 * @param _url - The `wss://…` base URL of the deployed room-hub worker.
 * @throws {Error} Always in the skeleton — not implemented.
 * @example
 * ```ts
 * createApp({ pluginConfigs: { transport: { signaling: serverSignaling("wss://room.example.com") } } });
 * ```
 */
export function serverSignaling(_url: string): Signaling {
  throw new Error("not implemented");
}
