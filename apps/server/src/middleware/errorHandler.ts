import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../utils/errors';
import { redactedPath } from '../utils/redactUrl';

/**
 * The client-error shape body-parser (via http-errors) throws: a numeric
 * `status`, `expose: true` for errors meant for the client, and a machine
 * `type`. Duck-typed — http-errors is not a direct dependency.
 */
interface ExposedHttpError {
  status: number;
  expose: true;
  type?: string;
}

function isExposedClientError(err: unknown): err is ExposedHttpError {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { status?: unknown; expose?: unknown };
  return typeof e.status === 'number'
    && Number.isInteger(e.status)
    && e.status >= 400
    && e.status <= 499
    && e.expose === true;
}

/** A URIError the router tagged as the client's (status 400): a bad percent-escape in the path. */
function isMalformedUrlError(err: unknown): boolean {
  if (!(err instanceof URIError) && (err as { name?: unknown } | null)?.name !== 'URIError') return false;
  return (err as { status?: unknown }).status === 400;
}

// A FIXED sentence per type, never err.message: a JSON parse error echoes
// fragments of the request body, and a body is never logged nor echoed
// (a Map, so a type like 'constructor' cannot hit an Object.prototype member)
const EXPOSED_ERROR_MESSAGES = new Map<string, string>([
  ['entity.too.large', 'Request body too large'],
  ['entity.parse.failed', 'Malformed JSON body'],
  ['charset.unsupported', 'Unsupported request encoding'],
  ['encoding.unsupported', 'Unsupported request encoding'],
]);

export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      success: false,
      error: err.message,
    });
  }

  // Body-parser failures (oversized body, malformed JSON, unsupported
  // charset) are the client's fault: answer their status in the house shape
  // instead of a logged stack and a 500
  if (isExposedClientError(err)) {
    const message = (typeof err.type === 'string' && EXPOSED_ERROR_MESSAGES.get(err.type)) || 'Invalid request';
    // Path redacted (a webhook token or invite code is a credential in the
    // URL), query dropped; never the body
    console.warn('[HTTP] Rejected request', { method: req.method, path: redactedPath(req.originalUrl ?? req.url), status: err.status });
    return res.status(err.status).json({
      success: false,
      error: message,
    });
  }

  // The router's param decoding (`/webhooks/<id>/<token>%zz`) throws a
  // URIError with status 400 and no `expose`, before any route middleware
  // runs. Its message quotes the raw segment, which may be a credential: a
  // fixed sentence, a redacted path, no message, no stack
  if (isMalformedUrlError(err)) {
    console.warn('[HTTP] Malformed URL', { method: req.method, path: redactedPath(req.originalUrl ?? req.url), status: 400 });
    return res.status(400).json({
      success: false,
      error: 'Malformed URL',
    });
  }

  if (process.env.NODE_ENV === 'production') {
    console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'error', message: err.message, stack: err.stack }));
  } else {
    console.error('[Error]', err);
  }

  return res.status(500).json({
    success: false,
    error: 'Internal server error',
  });
}
