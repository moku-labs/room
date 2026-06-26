// biome-ignore-all assist/source/organizeImports: barrel order is intentional (core imports → instance/adapter/type re-exports → the createCore wiring); biome's path-sort would scramble the import-before-createCore dependency and the grouped sections.
/**
 * @file `@moku-labs/room` — the client CORE (Step 2, spec/04 §4) and the package barrel. Calls `createCore`
 * on the shared `coreConfig` with the four engines as defaults + `browserEnv`, and EXPORTS the bound
 * `createApp` + `createPlugin`. The framework NEVER calls `createApp` — Layer-3 apps do. It has no node-only
 * code, so this one entry serves both the browser bundle and node tests (vitest provides `import.meta.env`);
 * there is no separate browser entry. A stage app adds `stagePlugin`; a controller app adds `controllerPlugin`
 * (plugins are uniform — no role arrays). The workerd signaling hub is the separate `./server` core.
 * @see ./config
 * @see ./server
 */
import { browserEnv } from "@moku-labs/common/browser";
import { coreConfig, createCore } from "./config";
import { intentPlugin } from "./plugins/intent";
import { sessionPlugin } from "./plugins/session";
import { syncPlugin } from "./plugins/sync";
import { transportPlugin } from "./plugins/transport";

// --- Plugin instances ---
export { transportPlugin } from "./plugins/transport";
export { sessionPlugin } from "./plugins/session";
export { intentPlugin } from "./plugins/intent";
export { syncPlugin } from "./plugins/sync";
export { stagePlugin } from "./plugins/stage";
export { controllerPlugin } from "./plugins/controller";

// --- Signaling adapter factories (publicRendezvous = DEFAULT, inMemory = tests, serverSignaling = opt-in worker-backed) ---
export { publicRendezvous } from "./plugins/transport/adapters/public-rendezvous";
export { inMemory } from "./plugins/transport/adapters/in-memory";
export { serverSignaling } from "./plugins/transport/adapters/server";

// --- Public wire/signaling protocol types (owned by `transport`, the base plugin) ---
export type {
  Signaling,
  SignalingSession,
  SignalingJoinOpts,
  SignalMsg,
  IceCandidateInit,
  Wire,
  Frame,
  IntentFrame,
  SyncSnapshotFrame,
  SyncDeltaFrame,
  HeartbeatPingFrame,
  HeartbeatPongFrame,
  RecoveryHelloFrame,
  RecoveryWelcomeFrame,
  RecoveryFlushFrame,
  PeerId,
  RosterEntry,
  Snapshot,
  Op,
  JsonValue,
  Namespace
} from "./plugins/transport/protocol";
export { MAX_CONTROLLERS, ROOM_CODE_LENGTH } from "./plugins/transport/protocol";

// --- Public event payload contract (each engine registers its own slice) ---
export type { RoomEvents } from "./config";

// --- Public plugin types (owned by their plugins) ---
export type { RoomDescriptor, JoinResult, QrMatrix } from "./plugins/session/types";
export type { StageApi } from "./plugins/stage/types";
export type { ControllerApi } from "./plugins/controller/types";

// --- Client core (Step 2): the four engines are the defaults; a stage/controller app adds its facade ---
const core = createCore(coreConfig, {
  plugins: [transportPlugin, sessionPlugin, intentPlugin, syncPlugin],
  pluginConfigs: { env: { providers: [browserEnv()] } }
});

/**
 * Create and initialize a `@moku-labs/room` app — the Layer-3 entry point. The four engines (transport,
 * session, intent, sync) are wired by default; add `stagePlugin` (host) or `controllerPlugin` (controller),
 * and select a signaling adapter via `pluginConfigs.transport.signaling`.
 *
 * @param options - `plugins` (the role facade + any custom plugins), `pluginConfigs`, `config`, and
 *   `onReady`/`onError`/`onStart`/`onStop` lifecycle callbacks.
 * @returns The initialized app: `start()`, `stop()`, every plugin's API, and `log`.
 * @example
 * ```ts
 * import { createApp, stagePlugin, publicRendezvous } from "@moku-labs/room";
 * const app = createApp({
 *   plugins: [stagePlugin],
 *   pluginConfigs: { transport: { signaling: publicRendezvous() } }
 * });
 * await app.start();
 * const room = await app.stage.createRoom();
 * ```
 */
export const createApp = core.createApp;

/**
 * Create a custom plugin bound to Room's `Config`/`Events` + core APIs. Types infer from the spec object —
 * never written explicitly. Pass the result to {@link createApp} via `plugins`.
 *
 * @example
 * ```ts
 * const score = createPlugin("score", { api: (ctx) => ({ bump: () => ctx.log.info("score:bump") }) });
 * ```
 */
export const createPlugin = core.createPlugin;
