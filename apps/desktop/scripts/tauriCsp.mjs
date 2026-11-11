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

/** Split `TAURI_ASSET_ORIGIN` ("https://a.example, https://b.example") into origins, refusing anything that is not a bare scheme://host[:port]. */
export function parseAssetOrigins(value) {
  const parts = (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const p of parts) {
    const m = ORIGIN_RE.exec(p);
    if (!m || !isCspHost(m[1]) || (m[2] !== undefined && !isTcpPort(m[2]))) {
      throw new Error(`TAURI_ASSET_ORIGIN must hold origins like https://host[:port], got "${p}"`);
    }
  }
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
