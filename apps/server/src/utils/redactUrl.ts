/**
 * Credentials that travel in a URL path, kept out of every log line that
 * carries a URL (the JSON access log, the error handler's warnings).
 *
 * - Invite codes: single-use bearer credentials (`/invites/:code`).
 * - Incoming-webhook tokens: `/api/v1/webhooks/:webhookId/:token` is the
 *   public execute route; the id stays (support needs it), the token segment
 *   is redacted. Anchored on the public prefix so the management route
 *   `/api/v1/servers/:id/webhooks/:webhookId/rotate` is left untouched.
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
    .replace(/^(\/api\/v1\/webhooks\/[^/?]+\/)[^/?]+/i, '$1[redacted]');
}

/** The redacted path of a URL, query string dropped (it may carry `?token=`). */
export function redactedPath(url: string): string {
  return redactUrl(url.split('?')[0]) ?? '';
}
