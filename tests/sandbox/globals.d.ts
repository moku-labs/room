/**
 * @file Ambient global augmentation for the sandbox demo. Both role entries publish a small, data-only
 * handle on the global object so the Playwright e2e specs (and a human poking the console) can read the
 * live room code / join state without scraping the DOM. Declared as global `var`s so BOTH `globalThis.x`
 * and `window.x` type-check (the latter via `Window & typeof globalThis`). Kept intentionally minimal —
 * the full `App` is not exposed; the demo drives gameplay through the DOM, exactly as a player would.
 */
import type { RoomDescriptor } from "../../src/index";

/** Host handle published by `stage.ts` once a room is open (freshly created OR reclaimed on host reload). */
type RoomStageHandle = {
  /** The 6-char room code controllers join with. */
  readonly code: string;
  /** The full controller join URL the QR encodes. */
  readonly joinUrl: string;
  /**
   * The verbatim descriptor `stage.createRoom()` returned. Absent on a host-reload RECLAIM, where the room
   * was restored from the persisted re-entry record rather than minted by a fresh `createRoom()` call.
   */
  readonly descriptor?: RoomDescriptor;
};

/** Controller handle published by `controller.ts`; `joined` flips to `true` once the channel is live. */
type RoomControllerHandle = {
  /** The room code this controller targeted (from `?room=` or manual entry), or `""` before join. */
  readonly code: string;
  /** `true` once `controller.joinRoom(code)` has resolved. */
  readonly joined: boolean;
};

declare global {
  var roomStage: RoomStageHandle | undefined;
  var roomController: RoomControllerHandle | undefined;
}
