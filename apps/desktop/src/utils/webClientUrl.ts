// The web client's address, for links someone else opens in a browser: an
// invite link (`/invite/<code>`, a route of the web client, which the API
// server does not serve). The server builds its own links (e-mails) from
// CLIENT_URL; this is the client-side counterpart.
//
// - In a browser the page IS the web client: its own origin.
// - The desktop app's page is the webview's internal origin
//   (http://tauri.localhost, tauri://localhost), which nobody else can open,
//   so the build has to be told: VITE_CLIENT_URL, compiled in like the other
//   VITE_* settings.
// - `tauri dev` loads the Vite dev server, which serves the web client: its
//   origin, as in a browser.
// - A desktop build without VITE_CLIENT_URL keeps the base links had before
//   it existed: VITE_WS_URL as written (then the page's origin), so a build
//   whose web client is served on the socket server's origin keeps working
//   links, character for character.

export interface WebClientContext {
  /** The page runs inside the Tauri webview. */
  isTauri: boolean;
  /** Vite's dev mode (the page comes from the dev server). */
  isDev: boolean;
  /** window.location.origin */
  pageOrigin: string;
  /** VITE_CLIENT_URL */
  clientUrl?: string;
  /** VITE_WS_URL */
  wsUrl?: string;
}

/**
 * The origin of a VITE_CLIENT_URL value: an http(s) URL without credentials,
 * query or fragment, whose path (if any) is dropped, since the web client's
 * routes live at the root. Null for an unset value, and for a malformed one
 * (with a warning that never quotes it).
 */
export function clientUrlOrigin(value: string | undefined, warn: (msg: string) => void = console.warn): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    warn('[Links] Ignoring VITE_CLIENT_URL: not an absolute URL (want https://host[:port])');
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    warn('[Links] Ignoring VITE_CLIENT_URL: it must use https: or http:');
    return null;
  }
  if (url.username || url.password || url.search || url.hash || /[?#]/.test(raw)) {
    warn('[Links] Ignoring VITE_CLIENT_URL: it must carry no credentials, query or fragment');
    return null;
  }
  return url.origin;
}

/** The base a link to the web client starts with (no trailing slash for an origin). */
export function webClientBase(ctx: WebClientContext, warn: (msg: string) => void = console.warn): string {
  if (!ctx.isTauri) return ctx.pageOrigin;
  const configured = clientUrlOrigin(ctx.clientUrl, warn);
  if (configured) return configured;
  if (ctx.isDev) return ctx.pageOrigin;
  return ctx.wsUrl || ctx.pageOrigin;
}

let cachedBase: string | null = null;

/** webClientBase for this build and this page (computed once: the inputs never change while the page lives). */
export function currentWebClientBase(): string {
  if (cachedBase === null) {
    cachedBase = webClientBase({
      isTauri: typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window,
      isDev: import.meta.env.DEV,
      pageOrigin: window.location.origin,
      clientUrl: import.meta.env.VITE_CLIENT_URL,
      wsUrl: import.meta.env.VITE_WS_URL,
    });
  }
  return cachedBase;
}

/** The invite link for `code`, opened by the web client's /invite/:code page. */
export function inviteLink(code: string, base: string = currentWebClientBase()): string {
  return `${base}/invite/${code}`;
}

/** Tests only: forget the computed base. */
export function resetWebClientBaseForTests(): void {
  cachedBase = null;
}
