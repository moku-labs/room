/**
 * @file hub plugin — default configuration (typed const; no inline `as`).
 */
import { ICE_PATH } from "../transport/ice-shared";
import type { Config } from "./types";

/** Framework default hub config; consumers override via `pluginConfigs.hub` (§Config). */
export const defaultConfig: Config = {
  doBinding: "ROOM_HUB",
  doClassName: "Hub",
  assetsBinding: "ASSETS",
  rateLimit: { joins: 30, windowSec: 60, kvBinding: "RATE_LIMIT" },
  ice: {
    path: ICE_PATH,
    keyIdBinding: "TURN_KEY_ID",
    apiTokenBinding: "TURN_KEY_API_TOKEN",
    rateLimit: { max: 30, windowSec: 60 }
  },
  joinWindowMs: 10_000,
  roomTtlMs: 1_800_000
};
