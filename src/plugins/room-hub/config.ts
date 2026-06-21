/**
 * @file room-hub plugin — default configuration (typed const; no inline `as`).
 */
import type { Config } from "./types";

/** Framework default room-hub config; consumers override via `pluginConfigs.roomHub` (§Config). */
export const defaultConfig: Config = {
  doBinding: "ROOM_HUB",
  doClassName: "RoomHub",
  assetsBinding: "ASSETS",
  rateLimit: { joins: 30, windowSec: 60, kvBinding: "RATE_LIMIT" },
  joinWindowMs: 10_000,
  roomTtlMs: 1_800_000
};
