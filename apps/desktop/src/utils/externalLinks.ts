// External links in the desktop app. Every link meant to leave the app is an
// anchor with target="_blank" (messages, the legal documents' web and mail
// links): in a browser it opens a new tab, which is all a browser needs. In
// the Tauri app it opens in the system browser or the mail client, from this
// ONE click handler, through the opener plugin's open_url. The plugin's own
// injected click script is turned off (src-tauri/src/lib.rs), and its
// capability allows exactly these schemes (src-tauri/capabilities/default.json).
//
// The href attribute is parsed without a base: a relative href (which would
// resolve to the app's own origin, an http(s) URL in the Tauri app) is no
// external link and is left to the webview, like every other scheme. The one
// exception is a scheme-relative href (`//host/path`), which names another
// host: it is opened over https, as a browser on an https page opens it.
//
// The handler listens on the document in the CAPTURE phase, before any of the
// app's own handlers: one that stops a click's propagation (a modal guarding
// its backdrop, a portal) would otherwise keep the click from it and leave the
// link to the webview. Such a link therefore always leaves the app; a link
// the app means to handle itself is not written with target="_blank".

/** The schemes the system may open; the capability's scope allows these and no other. */
export const EXTERNAL_LINK_PROTOCOLS: readonly string[] = ['http:', 'https:', 'mailto:'];

type OpenUrl = (url: string) => Promise<void>;

/** A scheme-relative reference: two slashes, then a host (not a third slash or a backslash). */
const SCHEME_RELATIVE_RE = /^\/\/[^/\\]/;

/** The URL a click on `anchor` hands to the system, or null when the app keeps the click. */
export function externalLinkUrl(anchor: Element): string | null {
  if ((anchor.getAttribute('target') ?? '').toLowerCase() !== '_blank') return null;
  const href = anchor.getAttribute('href');
  if (!href) return null;
  // `//host…`, never `///…` or `//` alone (which a URL parser reads as a host too)
  const absolute = SCHEME_RELATIVE_RE.test(href) ? `https:${href}` : href;
  let url: URL;
  try {
    url = new URL(absolute);
  } catch {
    // Relative, or not a URL at all: not an external link
    return null;
  }
  return EXTERNAL_LINK_PROTOCOLS.includes(url.protocol) ? url.href : null;
}

let openUrlPlugin: Promise<OpenUrl> | null = null;

/** The opener plugin's openUrl, loaded on the first external click (never in a browser). */
async function openWithSystem(url: string): Promise<void> {
  openUrlPlugin ??= import('@tauri-apps/plugin-opener').then((plugin) => plugin.openUrl);
  let openUrl: OpenUrl;
  try {
    openUrl = await openUrlPlugin;
  } catch (err) {
    // A failed load is tried again on the next click
    openUrlPlugin = null;
    throw err;
  }
  await openUrl(url);
}

let uninstall: (() => void) | null = null;

/**
 * Install the click handler, once, in the Tauri app only; a no-op in a
 * browser. Returns the function that removes it. `open` and `isTauri` are
 * for tests.
 */
export function installExternalLinkHandler(
  options: { isTauri?: boolean; open?: OpenUrl; root?: Document } = {}
): () => void {
  const isTauri = options.isTauri ?? (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window);
  if (!isTauri) return () => {};
  if (uninstall) return uninstall;

  const root = options.root ?? document;
  const open = options.open ?? openWithSystem;
  const onClick = (event: MouseEvent) => {
    // Already taken by a listener ahead of this one, or not the main button
    if (event.defaultPrevented || event.button !== 0) return;
    const anchor = event.target instanceof Element ? event.target.closest('a') : null;
    const url = anchor ? externalLinkUrl(anchor) : null;
    if (!url) return;
    // At once, before anything is awaited: the webview must not open a window of its own
    event.preventDefault();
    open(url).catch(() => {
      // A fixed line: what the plugin or the system rejects with can carry the
      // address (on macOS and Linux, the launcher's arguments), and a link may
      // be a credential (an invite)
      console.error('[Links] Could not open an external link');
    });
  };
  root.addEventListener('click', onClick, true);
  uninstall = () => {
    root.removeEventListener('click', onClick, true);
    uninstall = null;
  };
  return uninstall;
}
