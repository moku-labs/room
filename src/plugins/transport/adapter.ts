/**
 * @file The DOM-free `Signaling` adapter seam (contracts section 1, D12) — re-exported seam types plus
 * the two v1 adapter factories.
 * @see README.md
 *
 * DOM-free by construction: the seam types are the contracts' DOM-free `Signaling` / `SignalMsg` /
 * `IceCandidateInit`, re-exported here from the central `../../contracts` module (D16) so the adapter
 * implementations and `config.ts` reach the seam + factories through one stable path. `inMemory` needs
 * no `RTCPeerConnection`; a future server-side adapter drops in behind the same types.
 */
export type {
  IceCandidateInit,
  Signaling,
  SignalingJoinOpts,
  SignalingSession,
  SignalMsg
} from "../../contracts";
export { inMemory } from "./adapters/in-memory";
export { publicRendezvous } from "./adapters/public-rendezvous";
