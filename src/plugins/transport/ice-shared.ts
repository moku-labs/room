/**
 * @file transport/ice-shared.ts — the DOM-free ICE-provisioning contract shared by the browser
 * transport (the default lazy `/api/ice` credential fetch) and the hub's worker-side credential
 * endpoint (`../hub/ice.ts`). Like `protocol.ts`, this module uses no DOM types, so the hub's
 * workerd compilation (`tsconfig.worker.json` — no `lib: DOM`) consumes it untouched.
 *
 * Internet play: WebRTC's ICE negotiation already races local/STUN/relay candidate pairs in
 * parallel and picks the best — the framework's only job is to PROVISION the relay rung
 * (short-lived TURN credentials minted by the hub) and FAIL OPEN when it can't (the public-STUN
 * default keeps LAN + friendly-NAT internet behaviour). No fallback state machine exists on purpose.
 */

/** Same-origin path of the hub's ICE-credential endpoint (client fetch + hub route). */
export const ICE_PATH = "/api/ice";

/** Browser-side budget for the credential fetch — past this, connect proceeds with the STUN default. */
export const ICE_FETCH_TIMEOUT_MS = 2000;

/** Minted TURN credential lifetime — comfortably longer than any party session. */
export const ICE_CREDENTIAL_TTL_SECONDS = 4 * 60 * 60;

/**
 * One validated ICE server entry — structurally identical to the DOM's `RTCIceServer` (`urls` is
 * the one mandatory field; TURN entries add `username`/`credential`), declared locally so the
 * DOM-free hub compilation never needs `lib: DOM`.
 */
export type IceServer = {
  /** One STUN/TURN URL, or a non-empty list of them. */
  urls: string | string[];
  /** TURN username (absent on STUN entries). */
  username?: string;
  /** TURN credential (absent on STUN entries). */
  credential?: string;
};

/**
 * Normalize an untrusted `iceServers` value (the hub's JSON body on the client; Cloudflare's TURN
 * API body on the hub — which returns a SINGLE `RTCIceServer`-shaped object, not an array) into a
 * clean {@link IceServer} array. Unknown shapes yield `undefined` so every caller fails open.
 *
 * @param value - The untrusted `iceServers` payload (object, array, or garbage).
 * @returns The validated servers, or `undefined` when nothing usable survives.
 * @example
 * ```ts
 * normalizeIceServers({ urls: ["turn:turn.cloudflare.com:3478"], username: "u", credential: "c" });
 * // → [{ urls: [...], username: "u", credential: "c" }]
 * ```
 */
export function normalizeIceServers(value: unknown): readonly IceServer[] | undefined {
  const candidates = Array.isArray(value) ? value : [value];
  const servers: IceServer[] = [];

  for (const candidate of candidates) {
    const server = normalizeOne(candidate);
    if (server) servers.push(server);
  }

  return servers.length > 0 ? servers : undefined;
}

/**
 * Validate one candidate entry into an {@link IceServer}, or reject it.
 *
 * @param candidate - One untrusted entry.
 * @returns The validated server, or `undefined` when the entry is unusable.
 * @example
 * ```ts
 * normalizeOne({ urls: "stun:stun.cloudflare.com:3478" }); // → { urls: "stun:..." }
 * ```
 */
function normalizeOne(candidate: unknown): IceServer | undefined {
  if (typeof candidate !== "object" || candidate === null) return undefined;
  const record = candidate as Record<string, unknown>;

  // `urls` is the one mandatory field — a URL string or a non-empty array of URL strings.
  const validUrls = normalizeUrls(record["urls"]);
  if (!validUrls) return undefined;

  // TURN credentials ride along when present (STUN entries legitimately have neither).
  const username = typeof record["username"] === "string" ? record["username"] : undefined;
  const credential = typeof record["credential"] === "string" ? record["credential"] : undefined;
  return {
    urls: validUrls,
    ...(username === undefined ? {} : { username }),
    ...(credential === undefined ? {} : { credential })
  };
}

/**
 * Validate the `urls` field of one candidate: a URL string, or a non-empty all-string array.
 *
 * @param urls - The untrusted `urls` value.
 * @returns The validated urls, or `undefined` when malformed.
 * @example
 * ```ts
 * normalizeUrls(["stun:a", "turn:b"]); // → ["stun:a", "turn:b"]
 * ```
 */
function normalizeUrls(urls: unknown): string | string[] | undefined {
  if (typeof urls === "string") return urls;
  const isStringArray =
    Array.isArray(urls) && urls.length > 0 && urls.every(url => typeof url === "string");
  return isStringArray ? (urls as string[]) : undefined;
}
