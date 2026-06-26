/**
 * @file The DOM-free `Signaling` adapter seam (contracts section 1, D12) — re-exported seam types plus
 * the two v1 adapter factories.
 * @see README.md
 *
 * DOM-free by construction: the seam types are the DOM-free `Signaling` / `SignalMsg` /
 * `IceCandidateInit`, re-exported here from `./protocol` (transport's own wire/signaling contract) so the
 * adapter implementations reach the seam + factories through one stable path. `inMemory` needs no
 * `RTCPeerConnection`; a future server-side adapter drops in behind the same types.
 */

export { inMemory } from "./adapters/in-memory";
export { publicRendezvous } from "./adapters/public-rendezvous";
export type {
  IceCandidateInit,
  Signaling,
  SignalingJoinOpts,
  SignalingSession,
  SignalMsg
} from "./protocol";
