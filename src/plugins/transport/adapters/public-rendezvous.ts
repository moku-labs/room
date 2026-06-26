/**
 * @file The `publicRendezvous` signaling adapter — the DEFAULT (D11). Maps the Trystero v0.25.x
 * object/passive-room API onto the `Signaling` contract. Trystero is LAZY-LOADED via dynamic
 * `import("trystero/nostr")` / `import("trystero/torrent")` so it lands in a separate chunk (Nostr busts
 * the ~60 KiB Web budget if static). Does peerRegistry upsert-by-peerId (Trystero #77 unclean leave/join).
 * @see ../README.md
 */
import type { Signaling, SignalingJoinOpts, SignalingSession, SignalMsg } from "../protocol";

/** Moku Room's stable Trystero app namespace (scopes all Room rooms under one app id). */
const APP_ID = "moku-room";

/** Mandatory minimum Nostr relay redundancy (D11). */
const MIN_RELAY_REDUNDANCY = 3;

/** The single Trystero action channel name carrying every `SignalMsg` for the handshake. */
const SIGNAL_ACTION = "rmsig";

/** The slice of the Trystero v0.25.x `Room` this adapter consumes (object `makeAction`, peer callbacks). */
type TrysteroRoom = {
  makeAction(namespace: string): {
    send(data: unknown, options?: { target?: string | string[] | null }): Promise<void>;
    onMessage: ((data: unknown, context: { peerId: string }) => void) | null;
  };
  onPeerJoin: ((peerId: string) => void) | null;
  onPeerLeave: ((peerId: string) => void) | null;
  leave(): Promise<void>;
};

/** The `joinRoom` shape from `trystero/nostr` (lazy-imported). */
type JoinRoom = (config: Record<string, unknown>, roomId: string) => TrysteroRoom;

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
 * Lazy-loads the Trystero `joinRoom` for the chosen backbone so its code lands in a separate
 * `import()` chunk (statically importing Nostr would bust the ~60 KiB Web budget — D11).
 *
 * @param backbone - Which serverless backbone to import (`"nostr"` default, `"torrent"` fallback).
 * @returns The backbone module's `joinRoom` factory.
 * @example
 * ```ts
 * const joinRoom = await loadJoinRoom("nostr");
 * const room = joinRoom({ appId: "moku-room" }, "K7M2QX");
 * ```
 */
async function loadJoinRoom(backbone: "nostr" | "torrent"): Promise<JoinRoom> {
  const module =
    backbone === "torrent" ? await import("trystero/torrent") : await import("trystero/nostr");
  return (module as { joinRoom: JoinRoom }).joinRoom;
}

/**
 * Creates the default `Signaling` adapter (contracts section 1, D11): serverless rendezvous over Trystero
 * v0.25.x (Nostr backbone, BitTorrent fallback), lazy-loaded so its code never lands in the controller's
 * critical bundle. `join(code, opts)` joins the Trystero room, maps `onPeer`/`onPeerLeave`/`send`/`onSignal`
 * onto the contract, and upserts peers by id (Trystero #77). All-relays-unreachable surfaces as a thrown
 * error so `connect()` can emit `room:network-warning { reason: "rendezvous-unreachable" }`.
 *
 * @param options - Optional backbone + relay-redundancy overrides.
 * @returns A `Signaling` adapter backed by the Trystero serverless rendezvous.
 * @example
 * ```ts
 * const sig = publicRendezvous();
 * const host = await sig.join("K7M2QX", { selfId: "host_root" });
 * ```
 */
export function publicRendezvous(options?: PublicRendezvousOptions): Signaling {
  const backbone = options?.backbone ?? "nostr";
  const redundancy = Math.max(
    MIN_RELAY_REDUNDANCY,
    options?.relayRedundancy ?? MIN_RELAY_REDUNDANCY
  );

  /**
   * Joins the Trystero room for `code` and maps it onto a {@link SignalingSession} (contracts §1):
   * binds the action channel to `onSignal`, and the peer-join/leave callbacks with #77 upsert dedup.
   *
   * @param code - The 6-char room code that scopes the rendezvous (§6).
   * @param opts - Self id + passive/active role (the host offers; controllers join passive).
   * @returns The live signaling session bridging Trystero's peer/action API to the contract.
   * @example
   * ```ts
   * const session = await publicRendezvous().join("K7M2QX", { selfId: "host_root" });
   * ```
   */
  const join = async (code: string, opts: SignalingJoinOpts): Promise<SignalingSession> => {
    const joinRoom = await loadJoinRoom(backbone);
    const room = joinRoom(
      { appId: APP_ID, passive: opts.passive === true, relayConfig: { redundancy } },
      code
    );

    const action = room.makeAction(SIGNAL_ACTION);
    // peerRegistry upsert-by-peerId (Trystero #77): a re-`onPeerJoin` for an already-present id is
    // ignored, so the consumer's `onPeer` fires at most once per peer (no duplicate fan-out).
    const peers = new Set<string>();
    let signalHandler: ((peerId: string, msg: SignalMsg) => void) | null = null;

    /* eslint-disable jsdoc/require-jsdoc -- structural SignalingSession wiring; method semantics are documented on the contract in contracts.ts §1 */
    action.onMessage = (data, context): void => {
      signalHandler?.(context.peerId, data as SignalMsg);
    };

    return {
      onPeer(cb) {
        room.onPeerJoin = (peerId): void => {
          if (peers.has(peerId)) return;
          peers.add(peerId);
          cb(peerId);
        };
      },
      onPeerLeave(cb) {
        room.onPeerLeave = (peerId): void => {
          peers.delete(peerId);
          cb(peerId);
        };
      },
      onSignal(cb) {
        signalHandler = cb;
      },
      send(peerId, msg) {
        action.send(msg, { target: peerId }).catch(() => {
          /* best-effort: handshake send failures surface via connect timeout / heartbeat */
        });
      },
      async leave() {
        await room.leave();
      }
    };
    /* eslint-enable jsdoc/require-jsdoc */
  };

  return { join };
}
