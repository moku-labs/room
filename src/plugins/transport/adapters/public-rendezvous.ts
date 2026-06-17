/**
 * @file The `publicRendezvous` signaling adapter — the DEFAULT (D11). Maps the Trystero v0.25.x
 * object/passive-room API onto the `Signaling` contract. Trystero is LAZY-LOADED via dynamic
 * `import("trystero/nostr")` / `import("trystero/torrent")` so it lands in a separate chunk (Nostr busts
 * the ~60 KiB Web budget if static). Does peerRegistry upsert-by-peerId (Trystero #77 unclean leave/join).
 * @see ../README.md
 */
import type { Signaling } from "../adapter";

/**
 * Options for {@link publicRendezvous}. Selects the serverless backbone and tunes relay redundancy.
 *
 * @example
 * ```ts
 * const opts: PublicRendezvousOptions = { backbone: "nostr", relayRedundancy: 3 };
 * ```
 */
export type PublicRendezvousOptions = {
  /** The serverless backbone: Nostr (default, hundreds of relays) or BitTorrent (bundle-safe fallback). */
  readonly backbone?: "nostr" | "torrent";
  /** Minimum number of Nostr relays to connect for redundancy (D11 — mandatory >= 3). */
  readonly relayRedundancy?: number;
};

/**
 * Creates the default `Signaling` adapter (contracts section 1, D11): serverless rendezvous over Trystero
 * v0.25.x (Nostr backbone, BitTorrent fallback), lazy-loaded so its code never lands in the controller's
 * critical bundle. `join(code, opts)` joins the Trystero room, maps `onPeer`/`onPeerLeave`/`send`/`onSignal`
 * onto the contract, and upserts peers by id (Trystero #77). All-relays-unreachable surfaces as a thrown
 * error so `connect()` can emit `room:network-warning { reason: "rendezvous-unreachable" }`.
 *
 * @param options - Optional backbone + relay-redundancy overrides.
 * @example
 * ```ts
 * const sig = publicRendezvous();
 * const host = await sig.join("K7M2QX", { selfId: "host_root" });
 * ```
 */
export function publicRendezvous(options?: PublicRendezvousOptions): Signaling {
  throw new Error("not implemented");
}
