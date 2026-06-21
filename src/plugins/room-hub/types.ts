/**
 * @file room-hub plugin — type definitions skeleton.
 */
import type { ResourceManifest, WorkerEnv } from "@moku-labs/worker";

/** room-hub plugin configuration (see `.planning/specs/07-room-hub.md` §Config). */
export type Config = {
  readonly doBinding: string;
  readonly doClassName: string;
  readonly assetsBinding: string;
  readonly rateLimit: {
    readonly joins: number;
    readonly windowSec: number;
    readonly kvBinding: string;
  };
  readonly joinWindowMs: number;
  readonly roomTtlMs: number;
};

/** room-hub holds no cross-request state (env is threaded per call). */
export type State = Record<string, never>;

/** room-hub public API surface (mounted at `app.roomHub`). */
export type Api = {
  handle(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response>;
  deployManifest(): ResourceManifest[];
};
