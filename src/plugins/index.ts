// biome-ignore-all assist/source/organizeImports: two-section barrel — all namespace type re-exports first, then all plugin instances (moku spec/15 §6); biome's path-sort would interleave them.
/**
 * Internal plugin barrel for `@moku-labs/room`: namespace type surfaces + plugin instances.
 *
 * Namespace re-exports expose each Standard+ plugin's public `types.ts` under a stable name;
 * the instance re-exports feed the public barrel (`../index`), which composes them into the client core.
 *
 * @see ../index
 */

// --- Namespace type re-exports (alphabetical) ---
export * as Controller from "./controller/types";
export * as Intent from "./intent/types";
export * as Session from "./session/types";
export * as Stage from "./stage/types";
export * as Sync from "./sync/types";
export * as Transport from "./transport/types";

// --- Plugin instance re-exports ---
export { controllerPlugin } from "./controller";
export { intentPlugin } from "./intent";
export { sessionPlugin } from "./session";
export { stagePlugin } from "./stage";
export { syncPlugin } from "./sync";
export { transportPlugin } from "./transport";
