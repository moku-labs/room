// biome-ignore-all assist/source/organizeImports: barrel order is intentional (instances → roomPlugins composition → adapters → public types); biome's path-sort would scramble the import-before-const dependency and the grouped sections.
/**
 * `@moku-labs/room` public entry — a Moku plugin pack (NO Layer-2 shell, D1).
 *
 * Re-exports the six plugin instances, the pre-composed role arrays, the signaling adapter
 * factories, and the public contract type surface (the central `./contracts` module, D16).
 * Consumers spread `roomPlugins.stage` or `roomPlugins.controller` into their own `@moku-labs/web`
 * `createApp` — Room never calls `createCore`/`createApp` itself.
 *
 * @see ./contracts
 */

// --- Plugin instances ---
export {
  transportPlugin,
  sessionPlugin,
  intentPlugin,
  syncPlugin,
  stagePlugin,
  controllerPlugin
} from "./plugins";

import {
  transportPlugin,
  sessionPlugin,
  intentPlugin,
  syncPlugin,
  stagePlugin,
  controllerPlugin
} from "./plugins";

/**
 * Pre-composed Room plugin arrays for the two device roles. Spread one into a `@moku-labs/web`
 * `createApp`; the facade sits LAST so it sees all four engines' `room:*` events (WARN-2, D5).
 *
 * @see ./plugins
 */
export const roomPlugins = {
  stage: [transportPlugin, sessionPlugin, intentPlugin, syncPlugin, stagePlugin],
  controller: [transportPlugin, sessionPlugin, intentPlugin, syncPlugin, controllerPlugin]
} as const;

// --- Signaling adapter factories (publicRendezvous = DEFAULT, inMemory = tests) ---
export { publicRendezvous } from "./plugins/transport/adapters/public-rendezvous";
export { inMemory } from "./plugins/transport/adapters/in-memory";

// --- Public contract types (D16 — single physical home: ./contracts) ---
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
  Namespace,
  RoomEvents
} from "./contracts";
export { MAX_CONTROLLERS, ROOM_CODE_LENGTH } from "./contracts";

// --- Public plugin types (owned by their plugins) ---
export type { RoomDescriptor, JoinResult } from "./plugins/session/types";
export type { StageApi } from "./plugins/stage/types";
export type { ControllerApi } from "./plugins/controller/types";
