// The desktop app's Content Security Policy is static in tauri.conf.json and
// names only the app's own hosts. Avatars and space icons, though, answer a
// redirect to the deployment's object store, and their upload is a direct
// PUT to it, so a webview under that policy shows no avatar and refuses every
// avatar or icon change (the browser build has no such policy). The store's
// origin is a deployment detail, not something the repository should carry:
// the release build receives it as TAURI_ASSET_ORIGIN and merges it into the
// `img-src` and `connect-src` directives through `tauri build --config`.
//
// Pure functions here, so the desktop test suite can pin them; the CLI is
// tauri-release-config.mjs.

// A host the policy can name: dot-separated labels, none empty (an optional
// final dot is still a valid DNS name and CSP host). Anything else, an IPv6
// literal included, is not a CSP host-source: the webview drops such a source
// with a console warning and the policy silently loses it.
const HOST_RE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.?$/i;
const ORIGIN_RE = /^https?:\/\/([^/:?#]+)(?::(\d{1,5}))?$/i;
const DIRECTIVES = ['img-src', 'connect-src'];

/** Whether `host` is a hostname a CSP host-source can name. */
export function isCspHost(host) {
  return typeof host === 'string' && HOST_RE.test(host);
}

/** Whether `port` (digits) is a TCP port, 1..65535. */
export function isTcpPort(port) {
  const n = Number(port);
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

/** Why `part` is not a bare scheme://host[:port], in words that quote nothing of it; null when it is one. */
function originRuleBroken(part) {
  if (!/^https?:\/\//i.test(part)) return 'it must start with http:// or https://';
  if (part.slice(part.indexOf('//') + 2).includes('@')) return 'it must carry no credentials';
  const m = ORIGIN_RE.exec(part);
  if (!m) return 'nothing may follow the host and port (no path, query or trailing slash)';
  if (!isCspHost(m[1])) return 'its host must be dot-separated labels of letters, digits and hyphens (no IPv6 literal, wildcard or underscore)';
  if (m[2] !== undefined && !isTcpPort(m[2])) return 'its port must be 1 to 65535';
  return null;
}

/**
 * Split `TAURI_ASSET_ORIGIN` ("https://a.example, https://b.example") into
 * origins, refusing anything that is not a bare scheme://host[:port]. The
 * error names the entry's position and the rule it breaks, never the value:
 * the release workflow reads the variable from a secret, its log is public,
 * and GitHub masks the whole secret, not one part of a comma-separated value.
 */
export function parseAssetOrigins(value) {
  const parts = (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  parts.forEach((part, i) => {
    const broken = originRuleBroken(part);
    if (broken) {
      throw new Error(`TAURI_ASSET_ORIGIN entry ${i + 1} of ${parts.length} is not an origin like https://host[:port]: ${broken}`);
    }
  });
  return Array.from(new Set(parts));
}

/** The policy with every origin added once to `img-src` and `connect-src`; other directives untouched. */
export function withAssetOrigins(csp, origins) {
  if (typeof csp !== 'string' || !csp.trim()) throw new Error('The base CSP is empty');
  if (origins.length === 0) return csp;
  const directives = csp.split(';').map((d) => d.trim()).filter(Boolean);
  const seen = new Set();
  const out = directives.map((directive) => {
    const [name, ...sources] = directive.split(/\s+/);
    if (!DIRECTIVES.includes(name)) return directive;
    seen.add(name);
    const merged = [...sources];
    for (const origin of origins) if (!merged.includes(origin)) merged.push(origin);
    return [name, ...merged].join(' ');
  });
  for (const name of DIRECTIVES) {
    if (!seen.has(name)) throw new Error(`The base CSP has no ${name} directive to extend`);
  }
  return out.join('; ');
}

/** The JSON `tauri build --config` merges over tauri.conf.json, or null when no origin is set (the base policy ships as is). */
export function releaseConfig(tauriConf, assetOriginValue) {
  const origins = parseAssetOrigins(assetOriginValue);
  if (origins.length === 0) return null;
  const base = tauriConf?.app?.security?.csp;
  return { app: { security: { csp: withAssetOrigins(base, origins) } } };
}
