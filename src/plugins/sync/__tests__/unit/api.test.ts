/**
 * Unit tests for `createSyncApi` (`api.ts`): each method delegates to the engine and surfaces the
 * documented behavior. Engine mocked. Placeholders only — filled at build.
 *
 * @file
 * @see ../../README.md
 */
import { describe, it } from "vitest";

describe("createSyncApi", () => {
  it.todo("mutate on an unregistered namespace throws");
  it.todo("broadcast(peerId) sends a sync-snap to one peer; broadcast() sends a sync-delta to all");
  it.todo("exportSnapshot then mutate then importSnapshot(prev) restores prior state");
  it.todo("isReady mirrors the engine ready flag");
  it.todo("every API method delegates to the matching engine method");
});
