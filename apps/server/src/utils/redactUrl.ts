/**
 * Credentials that travel in a URL path, kept out of every log line that
 * carries a URL (the JSON access log, the error handler's warnings).
 *
 * - Invite codes: single-use bearer credentials (`/invites/:code`).
 * - Incoming-webhook tokens: `/api/v1/webhooks/:webhookId/:token` is the
 *   public execute route; the id stays (support needs it), EVERYTHING after it
 *   is redacted: the token, and whatever a mis-composed sender URL put around
 *   it (a dot segment, a trailing path, an empty id as in
 *   `/api/v1/webhooks//<token>`). Such a request matches no route and is a
 *   404, but it is still logged, with the token in it. The management routes
 *   (`/api/v1/servers/:id/webhooks/...`) never contain `/api/v1/webhooks/`,
 *   so they are left untouched.
 *
 * The webhook rule is deliberately NOT anchored at the start of the URL: an
 * absolute-form request target (`POST http://host/api/v1/webhooks/<id>/<token>`,
 * the proxy form) reaches Express, which routes it, and its originalUrl is
 * the whole absolute URL. Repeated slashes (`/api/v1//webhooks/<id>/<token>`,
 * what a base URL with a trailing slash composes) are matched too: such a URL
 * is not executed, but it is still logged. Over-redacting a stray look-alike
 * path costs nothing; under-redacting leaks a credential.
 *
 * Both rules ignore case: Express routes case-insensitively, so
 * `/API/V1/Webhooks/:id/:token` executes too and must be redacted too.
 *
 * - A `token` query parameter, on every path: no route reads a credential
 *   from the query string (the bearer travels in the Authorization header),
 *   but a request that carries one anyway (a hand-made link, a tool) must not
 *   write it to the log. Every occurrence, whatever the case of the key or
 *   how it is percent-encoded; the other parameters stay.
 *
 * Idempotent: the JSON access log applies it twice.
 *
 * Tokens and reset codes in POST bodies never reach a log line: no logger
 * here captures a body.
 */
export function redactUrl(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  const path = url
    .replace(/(\/invites\/)[^/?]+/i, '$1[redacted]')
    .replace(/(\/api\/+v1\/+webhooks\/+[^/?]*\/+)[^?]*/i, '$1[redacted]');
  return redactQueryCredentials(path);
}

/** Query keys whose value is a credential, compared decoded and lower-cased. */
const QUERY_CREDENTIAL_KEYS = new Set(['token']);

/** A query key as the query parser reads it ('+' is a space, escapes decoded). */
function decodedQueryKey(raw: string): string {
  try {
    return decodeURIComponent(raw.replace(/\+/g, ' ')).toLowerCase();
  } catch {
    // A malformed escape: the parser keeps such a key as written
    return raw.toLowerCase();
  }
}

/**
 * The URL with the value of every credential query parameter replaced by
 * `[redacted]`. Everything after the first `?` is read as the query, cut into
 * pairs at every `&` and every `#` (both kept): a client never sends a
 * fragment, so a `#` in a logged request line is text, and whatever follows
 * it, `#token=…` or `#&token=…`, is judged as a pair too. A credential's value
 * runs to the next `&`, so a `#` inside it hides the rest of it as well.
 */
function redactQueryCredentials(url: string): string {
  const start = url.indexOf('?');
  if (start === -1) return url;
  const parts = url.slice(start + 1).split(/([&#])/);
  let query = '';
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const eq = part === '&' || part === '#' ? -1 : part.indexOf('=');
    if (eq === -1 || !QUERY_CREDENTIAL_KEYS.has(decodedQueryKey(part.slice(0, eq)))) {
      query += part; // a separator, a bare key, or a pair that is not a credential
      continue;
    }
    query += `${part.slice(0, eq)}=[redacted]`;
    while (i + 1 < parts.length && parts[i + 1] !== '&') i++;
  }
  return `${url.slice(0, start + 1)}${query}`;
}

/** The redacted path of a URL, query string dropped. */
export function redactedPath(url: string): string {
  return redactUrl(url.split('?')[0]) ?? '';
}
