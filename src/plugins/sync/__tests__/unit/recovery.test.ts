/**
 * Unit tests for the persistence seam (`exportSnapshot`/`importSnapshot`) — the bytes `sessionPlugin`
 * persists for host-reload recovery (00-contracts §5). Placeholders only — filled at build.
 *
 * @file
 * @see ../../README.md
 */
import { describe, it } from "vitest";

describe("recovery seam", () => {
  it.todo("exportSnapshot output is JSON.parse(JSON.stringify(x))-stable");
  it.todo("importSnapshot(snap, sSeq) restores sSeq and marks namespaces registered");
  it.todo("importSnapshot flips ready to true");
  it.todo("a host broadcast(peerId) after import re-baselines the peer (00-contracts §5)");
});
