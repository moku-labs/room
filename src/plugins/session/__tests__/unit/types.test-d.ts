/**
 * @file Type-level tests (`expectTypeOf` / `@ts-expect-error`): `app.session` exposes exactly the
 * `SessionApi` signatures; `ctx.emit` accepts the three owned `room:*` names with their `RoomEvents`
 * payloads and rejects wrong payloads/unknown events; session-owned recovery `Frame` variants are
 * assignable to §2 `Frame`; no explicit generic is required on `createPlugin`.
 */

import { describe, it } from "vitest";

describe("types (type-level)", () => {
  it.todo("app.session exposes exactly the SessionApi method signatures");
  it.todo("ctx.emit accepts the three owned room:* names with RoomEvents payloads");
  it.todo("@ts-expect-error on a wrong room:* payload / unknown event");
  it.todo("@ts-expect-error fabricating a room:network-warning payload from session's context");
  it.todo("RecoveryHelloFrame/Welcome/Flush are assignable to §2 Frame (toMatchTypeOf<Frame>)");
  it.todo("createPlugin type-checks with NO explicit generics");
});
