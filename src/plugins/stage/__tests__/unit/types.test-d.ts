/**
 * @file stage — type-level tests (WARN-2 closure + StageApi surface).
 *
 * Proves the facade's re-declaration actually closes the event-visibility gap (contracts §3.3,
 * spec/14 §7): a game plugin with depends:[stagePlugin] must see ALL five room:* keys on its
 * ctx.emit / hooks surface, and reject unknown keys. Also pins the StageApi method signatures.
 *
 * This file uses top-level expectTypeOf / ts-expect-error statements. It is EXCLUDED from the
 * vitest include globs (only .test-d.ts files matching vitest's typecheck pattern are included),
 * so it is validated by `bunx tsc --noEmit` — NOT by `bunx vitest run`.
 */

import { expectTypeOf } from "vitest";
import type { RoomEvents } from "../../../../config";
import { createPlugin } from "../../../../index";
import type { QrMatrix, RoomDescriptor } from "../../../session/types";
import type { Cells } from "../../../sync/types";
import type { Namespace, PeerId, RosterEntry } from "../../../transport/protocol";
import { createStageApi } from "../../api";
import { stagePlugin } from "../../index";
import type { IntentHandler, MutateRecipe, StageApi } from "../../types";

// ---------------------------------------------------------------------------
// WARN-2 closure — a game plugin with depends:[stagePlugin] sees all five room:* keys
// ---------------------------------------------------------------------------

// Build a game plugin that depends on the stage facade. This is the canonical WARN-2 test:
// if stagePlugin does NOT re-declare all five room:* events, TypeScript will reject the hooks.
const _gamePlugin = createPlugin("testGame", {
  depends: [stagePlugin],
  hooks: _ctx => ({
    // All five room:* keys must be valid on a depends:[stagePlugin] context.
    // If any key is missing from stagePlugin's re-declared events, tsc reports an error here.
    "room:peer-joined": (_payload: RoomEvents["room:peer-joined"]) => {},
    "room:peer-left": (_payload: RoomEvents["room:peer-left"]) => {},
    "room:host-reconnecting": (_payload: RoomEvents["room:host-reconnecting"]) => {},
    "room:sync-ready": (_payload: RoomEvents["room:sync-ready"]) => {},
    "room:network-warning": (_payload: RoomEvents["room:network-warning"]) => {}
  })
});

// Reference _gamePlugin so it is not flagged as an unused variable.
const _pluginRef = _gamePlugin;

// ---------------------------------------------------------------------------
// StageApi surface pinning
// ---------------------------------------------------------------------------

// createStageApi (3-param, no transport) returns exactly StageApi
expectTypeOf(createStageApi).returns.toEqualTypeOf<StageApi>();

// StageApi method return types
expectTypeOf<StageApi["createRoom"]>().returns.toEqualTypeOf<RoomDescriptor>();
expectTypeOf<StageApi["qr"]>().returns.toEqualTypeOf<Promise<QrMatrix | null>>();
expectTypeOf<StageApi["roster"]>().returns.toEqualTypeOf<readonly RosterEntry[]>();
expectTypeOf<StageApi["broadcast"]>().returns.toEqualTypeOf<void>();
expectTypeOf<StageApi["mutate"]>().returns.toEqualTypeOf<void>();
expectTypeOf<StageApi["onIntent"]>().returns.toEqualTypeOf<() => void>();

// MutateRecipe is a return-next function (Cells -> Cells), not in-place void
expectTypeOf<MutateRecipe>().toEqualTypeOf<(draft: Cells) => Cells>();

// IntentHandler receives (payload: unknown, peerId: PeerId)
expectTypeOf<IntentHandler>().toEqualTypeOf<(payload: unknown, peerId: PeerId) => void>();

// mutate accepts a Namespace + MutateRecipe
expectTypeOf<StageApi["mutate"]>().parameter(0).toEqualTypeOf<Namespace>();
expectTypeOf<StageApi["mutate"]>().parameter(1).toEqualTypeOf<MutateRecipe>();

// onIntent accepts name + IntentHandler and returns unsubscribe
expectTypeOf<StageApi["onIntent"]>().parameter(0).toEqualTypeOf<string>();
expectTypeOf<StageApi["onIntent"]>().parameter(1).toEqualTypeOf<IntentHandler>();

// Keep references alive so TS doesn't prune the import
const _ref = _pluginRef;

export type { _ref as _ };
