/**
 * @file hub plugin — default configuration (typed const; no inline `as`).
 */
import type { Config } from "./types";

/** Framework default hub config; consumers override via `pluginConfigs.hub` (§Config). */
export const defaultConfig: Config = {
  doBinding: "ROOM_HUB",
  doClassName: "Hub",
  assetsBinding: "ASSETS",
  rateLimit: { joins: 30, windowSec: 60, kvBinding: "RATE_LIMIT" },
  joinWindowMs: 10_000,
  roomTtlMs: 1_800_000
};
