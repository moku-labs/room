/**
 * @file `intentPlugin` wiring harness — Standard tier. Composes state + api + the host receive path.
 * @see README.md
 *
 * Controller → host typed-input contract: typed intent registration + shape-checked, idempotent routing
 * over the transport `Wire` (NOT emit), plus the reconnect intent-buffer that `sessionPlugin` flushes.
 * Declares NO events; manages NO resource (no `onStart`/`onStop` — the `Wire.on` callback is subsumed by
 * `transport.onStop`). Depends on transport + session. No explicit generics — Config/State/Api all infer
 * from this spec object (R1). The extracted factories take destructured per-app pieces; `@moku-labs/web`
 * infers `ctx` inline here, so `api`/`onInit` bind the resolved transport `Wire` + session host-id.
 */
import { createPlugin } from "../../config";
import { sessionPlugin } from "../session";
import { transportPlugin } from "../transport";
import { createIntentApi } from "./api";
import { DEFAULT_INTENT_CONFIG } from "./config";
import { attachIntentReceive } from "./receive";
import { createIntentState } from "./state";

/* eslint-disable jsdoc/require-jsdoc -- structural wiring callbacks (api/onInit); domain JSDoc lives in the extracted state/api/receive modules */
/**
 * `intentPlugin` — Standard tier.
 *
 * Controller → host typed-input contract: typed intent registration + shape-checked, idempotent routing
 * over the transport `Wire` (NOT emit), plus the reconnect intent-buffer that `sessionPlugin` flushes.
 * Declares no events; manages no resource (no `onStart`/`onStop`). Depends on transport + session.
 *
 * @see README.md
 */
export const intentPlugin = createPlugin("intent", {
  depends: [transportPlugin, sessionPlugin],
  config: DEFAULT_INTENT_CONFIG,
  createState: createIntentState,
  api: ctx =>
    createIntentApi(ctx.state, ctx.config, ctx.require(transportPlugin).wire(), () =>
      ctx.require(sessionPlugin).hostId()
    ),
  onInit: ctx => attachIntentReceive(ctx.state, ctx.require(transportPlugin).wire())
});
/* eslint-enable jsdoc/require-jsdoc */
