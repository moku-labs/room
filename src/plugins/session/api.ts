/**
 * @file `createSessionApi` + `makeSessionDeps` — the API factory plus the `ctx`->`SessionDeps` builder.
 * `createSessionApi` is thin orchestration only: each method delegates to `lifecycle/*` (code/qr/roster)
 * and `recovery/*` (persistence/hosttoken/reentry/buffer/timeout) domain functions and pushes wire frames
 * through the transport API (`deps.requireTransport()`). No wire/DataChannel traffic flows through `emit` —
 * only the coarse `room:*` events do.
 * @see README.md
 *
 * Both functions take the destructured per-app pieces (never a `ctx` value/type): `@moku-labs/web` infers
 * `ctx` inline in `index.ts`, and `makeSessionDeps` narrows that inferred `ctx` (via the structural
 * {@link SessionContextShape}, NOT the web-unavailable `PluginContext`) into the {@link SessionDeps} bundle the
 * extracted modules consume. Keeping the builder HERE lets the `index.ts` harness stay a ≤30-line wiring.
 */

import { transportPlugin } from "../transport";
import { generateRoomCode } from "./lifecycle/code";
import { buildJoinUrl, buildQrMatrix } from "./lifecycle/qr";
import { readRoster } from "./lifecycle/roster";
import { mintHostToken } from "./recovery/hosttoken";
import { armPersistence, recordSnapshot, teardownSession } from "./recovery/persistence";
import { doJoinRoom, rejoinSameRoom, type SessionStateWithRuntime } from "./recovery/reentry";
import type { SessionApi, SessionContextShape, SessionDeps } from "./types";

/**
 * Narrows the inferred plugin `ctx` into the destructured {@link SessionDeps} bundle (D14): the per-app
 * `state` + frozen `config`, the three narrowed `room:*` `emit` closures, and a `requireTransport` closure
 * over `ctx.require(transportPlugin)`. Called inline by the `index.ts` wiring harness for both `api` and
 * `onInit`, so every extracted module stays `ctx`-free (and never imports the web-unavailable
 * `PluginContext`).
 *
 * @param ctx - The inferred plugin context, structurally narrowed to {@link SessionContextShape}.
 * @returns The destructured `SessionDeps` bundle for `createSessionApi`/`onInit`.
 * @example
 * ```ts
 * api: (ctx) => createSessionApi(makeSessionDeps(ctx));
 * ```
 */
/* eslint-disable jsdoc/require-jsdoc -- structural wiring closures (the narrowed room:* emit + requireTransport); domain JSDoc lives in the extracted modules */
export function makeSessionDeps(ctx: SessionContextShape): SessionDeps {
  return {
    state: ctx.state,
    config: ctx.config,
    emit: {
      peerJoined: payload => ctx.emit("room:peer-joined", payload),
      peerLeft: payload => ctx.emit("room:peer-left", payload),
      hostReconnecting: payload => ctx.emit("room:host-reconnecting", payload)
    },
    log: ctx.log,
    requireTransport: () => ctx.require(transportPlugin)
  };
}
/* eslint-enable jsdoc/require-jsdoc */

/**
 * Builds the public `SessionApi` bound to THIS app's destructured `deps` (D14 — closes over the per-app
 * `state`/`requireTransport`/`emit`, never a module-level singleton). Star-topology and the
 * `maxControllers` cap are enforced inside the returned methods (§6).
 *
 * @param deps - This app's destructured per-instance pieces (`state`, `config`, `emit`, `requireTransport`).
 * @returns The complete `SessionApi` for this app instance.
 * @example
 * ```ts
 * api: (ctx) => createSessionApi(makeSessionDeps(ctx));
 * ```
 */
export function createSessionApi(deps: SessionDeps): SessionApi {
  return {
    /** @inheritdoc */
    createRoom(): import("./types").RoomDescriptor {
      if (deps.state.role !== "none") {
        throw new Error(
          "[room] A room is already active. Call leave() before creating a new room.\n  Use session.leave() to exit the current room."
        );
      }

      // Mint identity for the host.
      deps.state.selfId = mintHostToken(); // re-use UUID for selfId (both are random unique ids)
      const code = generateRoomCode(undefined, deps.config.codeLength);
      const hostToken = mintHostToken();
      const joinUrlBase = deps.config.joinUrlBase;
      const joinUrl = buildJoinUrl(code, joinUrlBase);

      // Update state synchronously.
      deps.state.role = "host";
      deps.state.roomCode = code;
      deps.state.hostToken = hostToken;

      // Arm the persistence driver.
      deps.state.recovery.persistHandle = armPersistence(deps);

      // Tell transport to join as the host (star hub, active offerer).
      const transport = deps.requireTransport();
      transport.connect({ role: "host", selfId: deps.state.selfId, code }).catch(() => {
        // Best-effort: connection failure is surfaced via room:network-warning from transport.
      });

      // QR is async (lazy-imports `qrcode`) but createRoom is sync (§6.2 contract), so the descriptor
      // carries `qr: null`. The rendered matrix comes from the async `qr()` accessor below.
      const qr = null;

      return { code, joinUrl, qr, hostToken };
    },

    /** @inheritdoc */
    async qr(): Promise<import("./types").QrMatrix | null> {
      // No active room → nothing worth encoding (avoids a QR for an empty `?room=` URL).
      if (deps.state.roomCode === "") return null;

      const joinUrl = buildJoinUrl(deps.state.roomCode, deps.config.joinUrlBase);
      return buildQrMatrix(joinUrl, deps.config.generateQr);
    },

    /** @inheritdoc */
    async joinRoom(code: string): Promise<import("./types").JoinResult> {
      if (deps.state.role !== "none") {
        return { ok: false, reason: "unreachable" };
      }

      // Mint a stable selfId for this controller session.
      if (!deps.state.selfId) {
        deps.state.selfId = mintHostToken();
      }

      return doJoinRoom(deps, code);
    },

    /** @inheritdoc */
    async leave(): Promise<void> {
      if (deps.state.role === "none") return; // Idempotent.

      const transport = deps.requireTransport();

      // Close all connections.
      await transport.close();

      // Disarm recovery handles.
      teardownSession(deps.state);

      // Reset state to idle.
      deps.state.role = "none";
      deps.state.roomCode = "";
      deps.state.hostToken = "";
      deps.state.roster = {};
      deps.state.selfId = "";
      deps.state.recovery.phase = "stable";
      deps.state.recovery.buffer = [];
      deps.state.recovery.reconnectDeadline = 0;
    },

    /** @inheritdoc */
    async rejoin(): Promise<import("./types").JoinResult> {
      return rejoinSameRoom(deps);
    },

    /** @inheritdoc */
    roster(): readonly import("../../contracts").RosterEntry[] {
      return readRoster(deps.state);
    },

    /** @inheritdoc */
    self(): import("./types").SelfInfo {
      return {
        selfId: deps.state.selfId,
        role: deps.state.role,
        roomCode: deps.state.roomCode
      };
    },

    /** @inheritdoc */
    hostId(): import("../../contracts").PeerId {
      if (deps.state.role === "host") return deps.state.selfId;
      // Controller: return the stored host peer id.
      const runtime = deps.state as unknown as SessionStateWithRuntime;
      return runtime._hostId ?? "";
    },

    /** @inheritdoc */
    persistSnapshot(snapshot: import("../../contracts").Snapshot, sSeq: number): void {
      if (deps.state.role !== "host") return; // No-op on controller.
      // Capture the DO reclaim token (serverSignaling only; null otherwise) so a host reload can
      // re-attach to the warm room (§5.1, D25). exact-optional: omit the key when there is none.
      const reclaimToken = deps.requireTransport().reclaimToken();
      recordSnapshot(deps, {
        roomCode: deps.state.roomCode,
        hostToken: deps.state.hostToken,
        snapshot,
        sSeq,
        savedAt: Date.now(),
        ...(reclaimToken === null ? {} : { reclaimToken })
      });
    },

    /** @inheritdoc */
    recoveryPhase(): import("./types").RecoveryPhase {
      return deps.state.recovery.phase;
    }
  };
}
