import { API_BASE } from './apiBase';

/**
 * Which server a stored session belongs to.
 *
 * A token pair is a credential of the server that issued it, so the session
 * storage stamps every entry with the origin of the API this build talks to,
 * and never hands a build an entry stamped with another origin. A desktop
 * build for another server (`pnpm tauri:build`) has an identifier of its
 * own, and with it its own credential-store entries (lib.rs
 * `keychain_services`) and webview storage. Builds that share an identifier,
 * the official app and `tauri dev`, share one store: there the stamp is what
 * keeps one server's session from another's, and it is checked here, by the
 * app, not by the operating system.
 *
 * Entries written before the stamp existed carry no origin. Every desktop
 * build that could talk to its server until then was the official one (the
 * official policy refused any other server), so an unstamped entry is the
 * official service's: an official build keeps it (and stamps it), any other
 * build leaves it unread.
 */

/**
 * The official service's domain. The official release's Content Security
 * Policy allows exactly this domain and its subdomains over https
 * (tauri.conf.json; a test pins the two together), so the official build's
 * API lives under it, and no other build's can.
 */
export const OFFICIAL_SESSION_DOMAIN = 'voxium.app';

/** The origin of `url` (scheme, host, non-default port), or null when it is not an absolute URL. */
export function originOf(url: string): string | null {
  try {
    const { origin } = new URL(url);
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

/** Whether `origin` is the official service's: https on the default port, the official domain or one of its subdomains. */
export function isOfficialOrigin(origin: string | null): boolean {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    const host = url.hostname;
    return url.protocol === 'https:' && url.port === '' && (host === OFFICIAL_SESSION_DOMAIN || host.endsWith(`.${OFFICIAL_SESSION_DOMAIN}`));
  } catch {
    return false;
  }
}

/** The origin of the API this build is compiled for: what every stored session is stamped with and checked against. */
export const BUILD_API_ORIGIN: string = originOf(API_BASE) ?? API_BASE;
