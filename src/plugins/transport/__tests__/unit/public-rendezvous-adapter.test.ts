/**
 * @file Unit tests for the publicRendezvous adapter with Trystero mocked.
 * @see ../../adapters/public-rendezvous.ts
 */
import { describe, it, vi } from "vitest";

vi.mock("trystero/nostr");

describe("publicRendezvous adapter", () => {
  it.todo("join lazy-imports the Trystero backbone");
  it.todo("maps Trystero's object/passive-room API onto the Signaling contract");
  it.todo("upserts peers by id on re-onPeer (Trystero #77 — updates, does not duplicate)");
  it.todo("a thrown error on all-relays-unreachable surfaces to connect()");
});
