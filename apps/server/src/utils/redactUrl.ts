/**
 * Credentials that travel in a URL path, kept out of every log line that
 * carries a URL (the JSON access log, the error handler's warnings).
 *
 * - Invite codes: single-use bearer credentials (`/invites/:code`).
 * - Incoming-webhook tokens: `/api/v1/webhooks/:webhookId/:token` is the
 *   public execute route; the id stays (support needs it), the token segment
 *   is redacted. The management routes (`/api/v1/servers/:id/webhooks/...`)
 *   never contain `/api/v1/webhooks/`, so they are left untouched.
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
 * Tokens and reset codes in POST bodies never reach a log line: no logger
 * here captures a body.
 */
export function redactUrl(url: string | undefined): string | undefined {
  return url
    ?.replace(/(\/invites\/)[^/?]+/i, '$1[redacted]')
    .replace(/(\/api\/+v1\/+webhooks\/+[^/?]+\/+)[^/?]+/i, '$1[redacted]');
}

/** The redacted path of a URL, query string dropped (it may carry `?token=`). */
export function redactedPath(url: string): string {
  return redactUrl(url.split('?')[0]) ?? '';
}
