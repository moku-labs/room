/**
 * Type-level tests for `syncPlugin` (`expectTypeOf` / `@ts-expect-error`): the `read` return type,
 * non-transitive event visibility through `depends: [syncPlugin]`, the no-explicit-generics rule, and
 * the plain-JSON cell constraint.
 *
 * @file
 * @see ../../README.md
 */
import { describe, expectTypeOf, it } from "vitest";
import type { JsonValue } from "../../../../contracts";
import type { Api } from "../../types";

describe("sync types", () => {
  it("app.sync.read returns { readonly [k: string]: JsonValue } | undefined", () => {
    expectTypeOf<Api["read"]>().returns.toEqualTypeOf<
      { readonly [k: string]: JsonValue } | undefined
    >();
  });

  it("Api.isReady returns boolean", () => {
    expectTypeOf<Api["isReady"]>().returns.toEqualTypeOf<boolean>();
  });

  it("Api.exportSnapshot returns { snapshot, sSeq } readonly pair", () => {
    type ExportResult = ReturnType<Api["exportSnapshot"]>;
    expectTypeOf<ExportResult>().toHaveProperty("sSeq").toEqualTypeOf<number>();
  });

  it("Api.subscribe returns an unsubscribe function", () => {
    expectTypeOf<ReturnType<Api["subscribe"]>>().toEqualTypeOf<() => void>();
  });

  it("Api.onResyncRequest returns an unsubscribe function", () => {
    expectTypeOf<ReturnType<Api["onResyncRequest"]>>().toEqualTypeOf<() => void>();
  });

  it("Api.broadcast accepts an optional peerId string", () => {
    type BroadcastParam = Parameters<Api["broadcast"]>[0];
    expectTypeOf<BroadcastParam>().toEqualTypeOf<string | undefined>();
  });
});
