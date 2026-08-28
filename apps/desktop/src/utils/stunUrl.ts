// Where the client sends its STUN binding requests for DM calls.
//
// Privacy-first: STUN only, self-hosted, no third-party servers. A STUN
// request is ~100 bytes each way and carries no media; it tells the peer its
// own public address. The host defaults to the API host (coturn runs on the
// edge box next to nginx), and `VITE_STUN_URL` overrides it for a deployment
// that moves coturn to its own machine — the value is compiled into the
// bundle, so a change means rebuilding the desktop installers.

export const DEFAULT_STUN_PORT = 3478;

// `stun:host[:port]` or `stuns:host[:port]`. A TURN URL is refused on purpose:
// TURN relays media and needs credentials, and the Privacy Policy promises
// neither — adding it is a product decision, not a config value.
const STUN_URL_RE = /^stuns?:[^\s/?#@]+$/i;

export function isValidStunUrl(value: string): boolean {
  return STUN_URL_RE.test(value);
}

/** `stun:<host>:3478` for the host part of `wsUrl`, falling back to localhost. */
export function deriveStunUrl(wsUrl: string | undefined, warn: (msg: string, err?: unknown) => void = console.warn): string {
  let host = 'localhost';
  try {
    host = new URL(wsUrl || 'http://localhost:3001').hostname || 'localhost';
  } catch (err) {
    warn('[Voice] Failed to parse VITE_WS_URL for STUN host:', err);
  }
  return `stun:${host}:${DEFAULT_STUN_PORT}`;
}

/**
 * The STUN URL to hand RTCPeerConnection: `VITE_STUN_URL` when it is set and
 * well-formed, otherwise derived from `VITE_WS_URL`. A malformed override is
 * logged and IGNORED rather than shipped — an unparseable ICE server makes
 * `new RTCPeerConnection()` throw, which would take every DM call down with
 * a typo in an env file.
 */
export function resolveStunUrl(
  env: { VITE_STUN_URL?: string; VITE_WS_URL?: string },
  warn: (msg: string, err?: unknown) => void = console.warn,
): string {
  const override = env.VITE_STUN_URL?.trim();
  if (override) {
    if (isValidStunUrl(override)) return override;
    warn(`[Voice] Ignoring malformed VITE_STUN_URL ${JSON.stringify(override)} (want stun:host[:port]); deriving from VITE_WS_URL`);
  }
  return deriveStunUrl(env.VITE_WS_URL, warn);
}
