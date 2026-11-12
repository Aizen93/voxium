// A desktop build for someone else's server. tauri.conf.json is the project's
// own release configuration: its Content Security Policy names the project's
// hosts, its updater reads the project's feed and trusts the project's
// signing key. A build pointed at another server through VITE_API_URL /
// VITE_WS_URL would have its API and WebSocket refused by that policy, and an
// updater that replaces it with the project's installer (another server's
// build) at the next upstream release.
//
// `pnpm tauri:build` therefore merges this overlay over tauri.conf.json
// (`tauri build --config`, scripts/tauri-build-config.mjs):
// - `img-src` / `connect-src` lose every host the base policy names and get
//   the origins of the very URLs the frontend is compiled with, plus the
//   object store's (TAURI_ASSET_ORIGIN); every other directive is kept as is
//   and must name no host;
// - the updater reads the builder's own feed and key (TAURI_UPDATER_ENDPOINTS
//   + TAURI_UPDATER_PUBKEY), or there is no updater at all: no update
//   artifacts (so no signing key is needed) and no endpoint to ask.
// The official release does not use this file: it builds tauri.conf.json as
// is, with the storage origin from tauri-release-config.mjs.
//
// Pure functions, so the desktop test suite can pin them.

import { isCspHost, isTcpPort, parseAssetOrigins } from './tauriCsp.mjs';

const SERVER_DIRECTIVES = ['connect-src', 'img-src'];
const SCHEME_SOURCE_RE = /^[a-z][a-z0-9+.-]*:$/i;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** A keyword ('self'), a nonce or hash ('…') or a scheme source (blob:, data:) names no host; every other source does. */
export function isHostSource(source) {
  return !source.startsWith("'") && !SCHEME_SOURCE_RE.test(source);
}

/**
 * The URL a frontend setting holds, refused unless the policy can name its
 * origin: an absolute URL of one of `protocols`, no credentials, no query or
 * fragment (the app appends paths to it), a host a CSP source can name (an
 * IPv6 literal cannot be one). No message quotes the value: a builder's CI
 * may read it from a secret, and its log may be public.
 */
export function parseServerUrl(name, value, protocols) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) {
    throw new Error(`${name} is not set (environment or apps/desktop/.env*): the app would fall back to localhost:3001, which a self-hosted build does not allow`);
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} must be an absolute URL like ${protocols[protocols.length - 1]}//host[:port][/path] (with a port of 1 to 65535)`);
  }
  if (!protocols.includes(url.protocol)) {
    throw new Error(`${name} must use ${protocols.join(' or ')}`);
  }
  if (url.username || url.password) throw new Error(`${name} must not carry credentials`);
  // A bare `?` or `#` parses to an empty search or hash, so the raw text is checked too
  if (url.search || url.hash || /[?#]/.test(raw)) throw new Error(`${name} must not carry a query or a fragment`);
  if (!isCspHost(url.hostname) || (url.port && !isTcpPort(url.port))) {
    throw new Error(`${name} must name a DNS host or an IPv4 address the policy can allow (no IPv6 literal, no underscore)`);
  }
  return url;
}

/**
 * The sources the app's own server needs: the API origin for requests and
 * for `<img src="{VITE_API_URL}/uploads/…">` (avatars, icons, attachments),
 * the socket origin in both forms socket.io uses (`transports: ['polling',
 * 'websocket']`: HTTP long-polling first, then the WebSocket upgrade).
 */
export function serverSources(apiUrl, wsUrl) {
  const api = parseServerUrl('VITE_API_URL', apiUrl, ['http:', 'https:']);
  const ws = parseServerUrl('VITE_WS_URL', wsUrl, ['http:', 'ws:', 'https:', 'wss:']);
  const secure = ws.protocol === 'https:' || ws.protocol === 'wss:';
  // `host` omits a scheme's default port, as an origin does
  const apiOrigin = `${api.protocol}//${api.host}`;
  return {
    'connect-src': unique([apiOrigin, `${secure ? 'https' : 'http'}://${ws.host}`, `${secure ? 'wss' : 'ws'}://${ws.host}`]),
    'img-src': [apiOrigin],
  };
}

/**
 * `csp` with every host source of `img-src` and `connect-src` replaced by
 * `sources[directive]`, keywords and scheme sources kept. Throws when either
 * directive is missing, or when another directive names a host (the build
 * would keep a host that is not its own).
 */
export function selfHostedCsp(csp, sources) {
  if (typeof csp !== 'string' || !csp.trim()) throw new Error('The base CSP is empty');
  const seen = new Set();
  const out = csp
    .split(';')
    .map((d) => d.trim())
    .filter(Boolean)
    .map((directive) => {
      const [name, ...list] = directive.split(/\s+/);
      if (!SERVER_DIRECTIVES.includes(name)) {
        const host = list.find(isHostSource);
        if (host) throw new Error(`The base CSP's ${name} names the host ${host}: a self-hosted build would keep it`);
        return directive;
      }
      seen.add(name);
      return [name, ...unique([...list.filter((s) => !isHostSource(s)), ...(sources[name] ?? [])])].join(' ');
    });
  for (const name of SERVER_DIRECTIVES) {
    if (!seen.has(name)) throw new Error(`The base CSP has no ${name} directive to fill`);
  }
  return out.join('; ');
}

function decodeBase64Strict(value) {
  if (value.length % 4 !== 0 || !BASE64_RE.test(value)) return null;
  return Buffer.from(value, 'base64');
}

/**
 * The key material of an updater public key: the base64 of a minisign `.pub`
 * file (`tauri signer generate` prints it), whose second line is an Ed25519
 * key (`Ed`, an 8-byte key id, 32 key bytes). Throws on anything else: a key
 * the app cannot read fails every update with a dialog that only retries.
 */
export function parseUpdaterPubkey(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  const file = decodeBase64Strict(raw);
  const lines = file ? file.toString('utf8').split(/\r?\n/) : [];
  const keyLine = (lines[1] ?? '').trim();
  const key = decodeBase64Strict(keyLine);
  if (!lines[0]?.startsWith('untrusted comment:') || !key || key.length !== 42 || key.subarray(0, 2).toString('latin1') !== 'Ed') {
    throw new Error('TAURI_UPDATER_PUBKEY must be the public key `tauri signer generate` writes (the whole .pub file, base64 as printed)');
  }
  return keyLine;
}

/** The part of the official feed URL that names its repository (origin + two path segments), lower case: every feed under it is upstream's. */
function feedScope(endpoint) {
  try {
    const url = new URL(endpoint);
    const segments = url.pathname.split('/').filter(Boolean);
    const scope = segments.length > 2 ? `${url.origin}/${segments.slice(0, 2).join('/')}/` : url.href;
    return scope.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * The updater a self-hosted build ships. Both settings or neither: neither is
 * no updater (`createUpdaterArtifacts: false`, no endpoint, no key); both is
 * the builder's feed (https only: a release build refuses any other scheme
 * when the plugin starts, so the app would not open) and key.
 *
 * The project's key is refused (its key material, however it is wrapped):
 * with it, only the project could sign this build's updates. The project's
 * feed is refused as a guard against ACCIDENTS only, a value copied from
 * tauri.conf.json or the same URL in another case: the check compares the
 * lower-cased URL with the official repository's prefix, so `www.github.com`,
 * a final dot, percent-encoding or a doubled `/` pass. It is no security
 * boundary and needs to be none: with the builder's own key, an update the
 * project signed cannot install. What the guard spares is the build's users
 * a mandatory update dialog that fails at every upstream release.
 */
export function selfHostedUpdater(endpointsValue, pubkeyValue, official) {
  const endpoints = (endpointsValue ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const pubkey = (pubkeyValue ?? '').trim();
  if (endpoints.length === 0 && !pubkey) {
    // The block stays, emptied: the updater plugin is always registered and
    // refuses to start without a `pubkey` key (src-tauri/src/lib.rs pins
    // that this exact block lets the app start). With no endpoint its
    // check() answers an error at once and asks nobody.
    return { createUpdaterArtifacts: false, updater: { endpoints: [], pubkey: '' } };
  }
  if (endpoints.length === 0 || !pubkey) {
    throw new Error('TAURI_UPDATER_ENDPOINTS and TAURI_UPDATER_PUBKEY go together: set both for your own update feed, or neither for a build without an updater');
  }
  const officialScopes = (official?.endpoints ?? []).map(feedScope).filter(Boolean);
  endpoints.forEach((endpoint, i) => {
    // The entry's position, never its value: the setting may come from a secret
    const entry = `TAURI_UPDATER_ENDPOINTS entry ${i + 1} of ${endpoints.length}`;
    let url;
    try {
      url = new URL(endpoint);
    } catch {
      throw new Error(`${entry} must be an https URL`);
    }
    if (url.protocol !== 'https:') throw new Error(`${entry} must be an https URL (the release build refuses any other scheme)`);
    if (url.username || url.password) throw new Error(`${entry} must not carry credentials`);
    const href = url.href.toLowerCase();
    if (officialScopes.some((scope) => href.startsWith(scope))) {
      throw new Error(`${entry} names the Voxium project's own update feed: publish your builds on a feed of your own`);
    }
  });
  const key = parseUpdaterPubkey(pubkey);
  let officialKey = null;
  try {
    officialKey = official?.pubkey ? parseUpdaterPubkey(official.pubkey) : null;
  } catch {
    officialKey = null;
  }
  if (officialKey && key === officialKey) {
    throw new Error('TAURI_UPDATER_PUBKEY is the Voxium project\'s own signing key: generate a key pair of your own (`pnpm tauri signer generate`)');
  }
  return { createUpdaterArtifacts: true, updater: { endpoints, pubkey } };
}

/**
 * The JSON `tauri build --config` merges over tauri.conf.json for a
 * self-hosted build. Always the three parts, never a `null`: tauri-cli 2.12
 * keeps a null when it combines several `--config` patches, and the JSON
 * merge patch it then applies to tauri.conf.json (json_patch::merge, as
 * tauri-build does with TAURI_CONFIG) removes the key it names. Either way
 * the updater plugin is handed no block, and the app does not start without
 * one (src-tauri/src/lib.rs pins that a null block is refused).
 */
export function selfHostedConfig(tauriConf, { apiUrl, wsUrl, assetOrigin, updaterEndpoints, updaterPubkey } = {}) {
  const server = serverSources(apiUrl, wsUrl);
  const assets = parseAssetOrigins(assetOrigin);
  const csp = selfHostedCsp(tauriConf?.app?.security?.csp, {
    'connect-src': [...server['connect-src'], ...assets],
    'img-src': [...server['img-src'], ...assets],
  });
  const { createUpdaterArtifacts, updater } = selfHostedUpdater(updaterEndpoints, updaterPubkey, tauriConf?.plugins?.updater);
  return {
    app: { security: { csp } },
    bundle: { createUpdaterArtifacts },
    plugins: { updater },
  };
}

function unique(list) {
  return Array.from(new Set(list));
}
