/**
 * @file Type-level tests for the hub plugin (`expectTypeOf` / `@ts-expect-error`). Pins the
 * client↔DO protocol discriminants (`ClientEnvelope`/`ServerEnvelope` `kind` unions, contracts §1.3) and
 * the public `Api` surface mounted at `app.hub` (`handle` → `Promise<Response>`), and asserts an invalid
 * envelope `kind` is a compile error. Validated by `bunx tsc --noEmit` — this file is EXCLUDED from vitest
 * `include` (`.test-d.ts` convention).
 */
import { expectTypeOf } from "vitest";
import type { ClientEnvelope, ServerEnvelope } from "../../../transport/protocol";
import type { Api } from "../../types";

// ---------------------------------------------------------------------------
// ClientEnvelope `kind` discriminant union (contracts §1.3)
// ---------------------------------------------------------------------------

// The three client→DO frame kinds, exhaustively.
expectTypeOf<ClientEnvelope["kind"]>().toEqualTypeOf<"join" | "reclaim" | "relay">();

// Narrowing on `kind` reaches each variant's payload fields.
expectTypeOf<Extract<ClientEnvelope, { kind: "join" }>>().toExtend<{
  kind: "join";
  selfId: string;
  role: "host" | "controller";
}>();
expectTypeOf<Extract<ClientEnvelope, { kind: "reclaim" }>>().toHaveProperty("reclaimToken");
expectTypeOf<Extract<ClientEnvelope, { kind: "relay" }>>().toHaveProperty("msg");

// ---------------------------------------------------------------------------
// ServerEnvelope `kind` discriminant union (contracts §1.3)
// ---------------------------------------------------------------------------

expectTypeOf<ServerEnvelope["kind"]>().toEqualTypeOf<
  "join-ack" | "peer-arrived" | "peer-left" | "reclaim-ack" | "relay" | "full" | "evict" | "error"
>();

// ---------------------------------------------------------------------------
// Public hub Api surface (mounted at app.hub)
// ---------------------------------------------------------------------------

// `handle` is the sole worker fetch handler → Promise<Response>.
expectTypeOf<Api["handle"]>().returns.toEqualTypeOf<Promise<Response>>();
// Its first parameter is the inbound Cloudflare `Request`, its third the `ExecutionContext`.
expectTypeOf<Parameters<Api["handle"]>[0]>().toEqualTypeOf<Request>();
expectTypeOf<Parameters<Api["handle"]>[2]>().toEqualTypeOf<ExecutionContext>();

// ---------------------------------------------------------------------------
// An invalid envelope `kind` must be a compile error
// ---------------------------------------------------------------------------

// @ts-expect-error — "bogus" is not a ClientEnvelope kind (only join | reclaim | relay).
const _bogus: ClientEnvelope = { kind: "bogus", selfId: "h", role: "host" };
expectTypeOf<typeof _bogus>().toEqualTypeOf<ClientEnvelope>();
