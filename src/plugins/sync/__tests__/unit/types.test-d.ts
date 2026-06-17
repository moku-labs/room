/**
 * Type-level tests for `syncPlugin` (`expectTypeOf` / `@ts-expect-error`): the `read` return type,
 * non-transitive event visibility through `depends: [syncPlugin]`, the no-explicit-generics rule, and
 * the plain-JSON cell constraint. Placeholders only — filled at build.
 *
 * @file
 * @see ../../README.md
 */
import { describe, it } from "vitest";

describe("sync types", () => {
  it.todo("app.sync.read returns { readonly [k: string]: JsonValue } | undefined");
  it.todo("depends: [syncPlugin] sees room:sync-ready in emit/hooks");
  it.todo("@ts-expect-error: room:peer-joined is NOT visible through depends: [syncPlugin] alone");
  it.todo('@ts-expect-error: explicit generics on createPlugin("sync", ...) are forbidden (R1)');
  it.todo('@ts-expect-error: registerSlice("x", { bad: new Map() }) rejects a non-JsonValue cell');
});
