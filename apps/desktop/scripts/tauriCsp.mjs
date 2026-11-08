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

const ORIGIN_RE = /^https?:\/\/[a-z0-9.-]+(?::\d{1,5})?$/i;
const DIRECTIVES = ['img-src', 'connect-src'];

/** Split `TAURI_ASSET_ORIGIN` ("https://a.example, https://b.example") into origins, refusing anything that is not a bare scheme://host[:port]. */
export function parseAssetOrigins(value) {
  const parts = (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const p of parts) {
    if (!ORIGIN_RE.test(p)) {
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
