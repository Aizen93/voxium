import crypto from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import express, { Router, type Request, type Response, type NextFunction } from 'express';
import { LIMITS, type Message } from '@voxium/shared';
import type { Prisma } from '../generated/prisma/client';
import { prisma } from '../utils/prisma';
import { getIO } from '../websocket/socketServer';
import { requireFeature } from '../middleware/requireFeature';
import { rateLimitWebhookExecute, rateLimitWebhookExecuteIp, refundRateLimit } from '../middleware/rateLimiter';
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
  UnauthorizedError,
  UnsupportedMediaTypeError,
} from '../utils/errors';
import { shapeMessageRow } from '../utils/messageAuthor';
import { openSecret } from '../utils/secretBox';
import { renderDiscordPayload, type RenderedWebhookMessage } from '../utils/webhooks/discordPayload';
import { renderGitHubEvent, verifyGitHubSignature } from '../utils/webhooks/githubFormatter';

/**
 * The PUBLIC incoming-webhook execute route: `POST /api/v1/webhooks/:webhookId/:token`.
 *
 * The first unauthenticated write endpoint in the API. Mounted by app.ts
 * BEFORE the global 100 KB JSON parser and OUTSIDE the api router (so outside
 * its per-IP rateLimitGeneral): it has its own 1 MB parser and its own two
 * limiters. The route is a middleware chain in which each guard is cheap
 * before the next one spends anything:
 *
 *   [router level] kill switch → per-IP limiter
 *   [route]        JSON content type → token check (one query) → channel
 *                  → GitHub only: open the sealed secret
 *                  → per-webhook limiter
 *                  → body parser (GitHub only: the signature over the raw
 *                    bytes, checked BEFORE they are parsed)
 *                  → render + insert + broadcast
 *
 * The kill switch and the per-IP limiter are ROUTER-level on purpose: the
 * router decodes the route params while matching the route, and a bad
 * percent-escape (`/<id>/<token>%zz`) throws there, before any route
 * middleware; at router level both still run for it (the error handler then
 * answers 400 'Malformed URL'). The body parser runs only on a validated
 * token: a wrong token never makes the server read or parse a 1 MB body.
 *
 * The token is the credential: only its SHA-256 is stored, it is compared in
 * constant time, an unknown id and a wrong token cost the same single query
 * and answer the identical 404, and the access log redacts it
 * (utils/redactUrl.ts). Neither the token nor the body is ever logged.
 *
 * The handler renders by webhook TYPE, chosen at creation (never guessed
 * from the body, so a mismatch is reported instead of failing silently):
 * - generic: the Discord shape (utils/webhooks/discordPayload.ts); a delivery
 *   carrying X-GitHub-Event is refused with a 400 that says so.
 * - github: the token check also opens the webhook's sealed secret (503
 *   when it is missing or cannot be opened: a server-side fault, not the
 *   sender's, answered before a byte of the body is read). The body parser's
 *   verify hook then checks X-Hub-Signature-256 against the HMAC-SHA256 of
 *   the raw bytes BEFORE JSON.parse runs: a mismatch (or no signature) is 401
 *   'Invalid signature', nothing is parsed or posted, and the per-webhook
 *   point is REFUNDED — whoever holds the URL but not the secret pays the
 *   per-IP bucket only, and cannot starve GitHub's real deliveries. (A
 *   request without any body is a 415 before the token check; a body the
 *   parser does not read, being consumed upstream, never meets the hook, so
 *   the handler fails closed with the same 401.)
 *   Then X-GitHub-Event is required (missing or empty: a 400 that says so, as
 *   a plain Discord-shaped body gets), then the GitHub formatter
 *   (utils/webhooks/githubFormatter.ts). An event or action it ignores
 *   answers 204 (200 with data: null under ?wait=true) and posts nothing, but
 *   still moves lastUsedAt: the delivery was authentic. The secret, the
 *   signature and the body are never logged.
 */

type ExecuteParams = { webhookId: string; token: string };

// The same author/attachment shapes routes/messages.ts selects, so a webhook
// row and a human row reach the client in one shape
const authorSelect = {
  select: { id: true, username: true, displayName: true, avatarUrl: true, role: true, isSupporter: true, supporterTier: true },
} as const;

const attachmentSelect = {
  select: { id: true, s3Key: true, fileName: true, fileSize: true, mimeType: true, expired: true },
} as const;

// Scalars only, so the token check costs exactly one query on a hit and on a
// miss; the channel is read only once the token has matched
const webhookSelect = {
  id: true,
  tokenHash: true,
  enabled: true,
  type: true,
  secretEnc: true,
  channelId: true,
  serverId: true,
  name: true,
} as const satisfies Prisma.WebhookSelect;

const channelSelect = {
  serverId: true,
  type: true,
  secure: true,
  name: true,
  server: { select: { name: true } },
} as const satisfies Prisma.ChannelSelect;

type WebhookRow = Prisma.WebhookGetPayload<{ select: typeof webhookSelect }>;
type WebhookChannel = Prisma.ChannelGetPayload<{ select: typeof channelSelect }>;

/** What res.locals.webhook carries past the token check: the row and its channel. */
export type ExecutableWebhook = WebhookRow & { channel: WebhookChannel };

/** What the route's guards leave on res.locals for the ones after them. */
interface ExecuteLocals {
  webhook?: ExecutableWebhook;
  /** A GitHub row's opened secret: set by loadWebhook, used (then dropped) by the parser's verify hook. */
  webhookSecret?: string;
  /** Set by the verify hook once X-Hub-Signature-256 matched the raw bytes. */
  signatureVerified?: boolean;
}

function localsOf(res: Response | ServerResponse): ExecuteLocals {
  return (res as Response).locals as ExecuteLocals;
}

// The one path shape this router serves, as the route matches it (two
// segments, an optional trailing slash). The router-level guards run for it
// alone; any other request leaves the router untouched
const EXECUTE_PATH_RE = /^\/[^/]+\/[^/]+\/?$/;
// Ids are cuids; anything else cannot exist, so it is a miss without a query
const WEBHOOK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TOKEN_HASH_RE = /^[0-9a-fA-F]{64}$/;
// What a miss is compared against, so an unknown id costs the same hash and
// the same constant-time compare as a wrong token (64 hex zeros, decoded)
const DUMMY_TOKEN_DIGEST = Buffer.alloc(32);
// lastUsedAt is a "roughly when" for the settings list, not an audit trail:
// at most one write per webhook per minute
export const LAST_USED_THROTTLE_MS = 60_000;

const DISABLED_MESSAGE = 'Webhooks are currently disabled';

/** 415 unless the body is declared JSON (a `; charset=utf-8` suffix is fine).
 *  express.json() would silently skip any other type and leave req.body
 *  undefined; a form-encoded GitHub hook gets a sentence it can act on. */
function requireJson(req: Request, _res: Response, next: NextFunction): void {
  if (!req.is('application/json')) {
    next(new UnsupportedMediaTypeError('Send application/json'));
    return;
  }
  next();
}

/** Router-level: only a POST to the execute path meets the guards below. */
function executeRequestsOnly(req: Request, _res: Response, next: NextFunction): void {
  if (req.method !== 'POST' || !EXECUTE_PATH_RE.test(req.path)) {
    next('router');
    return;
  }
  next();
}

/** A foreign-key failure: the webhook (or its channel) was deleted meanwhile. */
function isForeignKeyViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2003';
}

/**
 * A GitHub row always gets a sealed secret at creation and on rotate: its
 * absence, or a value that will not open (key missing or changed, value
 * tampered with), is the server's fault, never the sender's. Logs the
 * webhook id and the error message only.
 */
function openGitHubSecret(row: WebhookRow): string {
  if (row.secretEnc === null) {
    console.error('[Webhooks] GitHub webhook has no secret', { webhookId: row.id });
    throw new ServiceUnavailableError('Webhook secret is not configured');
  }
  try {
    return openSecret(row.secretEnc);
  } catch (err) {
    console.error('[Webhooks] Could not open a GitHub webhook secret', {
      webhookId: row.id,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new ServiceUnavailableError('Webhook secret is unavailable');
  }
}

/**
 * The 401 for a GitHub delivery whose signature does not match, after giving
 * back the per-webhook point it was charged: a failure must not count
 * against the webhook (refundRateLimit never throws; the reply does not wait
 * for it).
 */
function invalidSignature(webhookId: string): UnauthorizedError {
  void refundRateLimit('webhookExecute', webhookId);
  return new UnauthorizedError('Invalid signature');
}

/**
 * The body parser's verify hook: runs on the exact request bytes BEFORE they
 * are parsed. Keeps them on req.rawBody; for a GitHub row, checks
 * X-Hub-Signature-256 over them and throws the 401 on a mismatch, so nothing
 * a sender without the secret sends is ever parsed. body-parser hands the
 * thrown error on as the same instance (http-errors keeps it and its 401
 * status), and the error handler answers it in the house shape.
 */
function verifyRawBody(req: IncomingMessage, res: ServerResponse, buf: Buffer): void {
  const request = req as Request;
  request.rawBody = buf;
  const locals = localsOf(res);
  const webhook = locals.webhook;
  if (webhook?.type !== 'github') return;
  const secret = locals.webhookSecret;
  // Needed for this check alone: not kept for the rest of the request
  delete locals.webhookSecret;
  if (secret === undefined || !verifyGitHubSignature(buf, request.get('x-hub-signature-256'), secret)) {
    throw invalidSignature(webhook.id);
  }
  locals.signatureVerified = true;
}

/**
 * Resolve the webhook and check its token. The SHA-256 of the presented token
 * is computed on every path and always compared in constant time — against
 * the stored hash, or against a fixed dummy digest on a miss — so an unknown
 * id and a wrong token do the same work (one scalar query) and answer the
 * identical 404. Only a matched token reads the channel.
 */
async function loadWebhook(req: Request<ExecuteParams>, res: Response, next: NextFunction): Promise<void> {
  try {
    const { webhookId, token } = req.params;
    const presented = crypto.createHash('sha256').update(token, 'utf8').digest();

    const row = WEBHOOK_ID_RE.test(webhookId)
      ? await prisma.webhook.findUnique({ where: { id: webhookId }, select: webhookSelect })
      : null;

    // A stored hash of an unexpected shape counts as a miss, never a throw
    const storedUsable = row !== null && TOKEN_HASH_RE.test(row.tokenHash);
    const stored = storedUsable ? Buffer.from(row.tokenHash, 'hex') : DUMMY_TOKEN_DIGEST;
    const tokenMatches = crypto.timingSafeEqual(presented, stored);
    if (!row || !storedUsable || !tokenMatches) throw new NotFoundError('Webhook');

    const channel = await prisma.channel.findUnique({ where: { id: row.channelId }, select: channelSelect });
    // Gone between the two reads (the webhook cascades with it): a miss
    if (!channel) throw new NotFoundError('Webhook');

    // Defensive: the management API never binds a webhook to a secure or a
    // voice channel. If a row ever is, it answers like a nonexistent webhook
    if (channel.secure || channel.type !== 'text' || channel.serverId !== row.serverId) {
      console.warn('[Webhooks] Refusing a webhook bound to a channel it cannot post in', {
        webhookId: row.id,
        channelId: row.channelId,
      });
      throw new NotFoundError('Webhook');
    }

    if (!row.enabled) throw new ForbiddenError('Webhook is disabled');

    const webhook: ExecutableWebhook = { ...row, channel };
    const locals = localsOf(res);
    locals.webhook = webhook;
    // The parser's verify hook checks a GitHub signature before anything is
    // parsed, so the secret must be in hand first — and a secret that will
    // not open is answered here, before a byte of the body is read
    if (row.type === 'github') locals.webhookSecret = openGitHubSecret(row);
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * A GitHub delivery: signature (already checked by the parser's verify
 * hook), event header, then the formatter, in that order, so nothing a
 * sender without the secret sends is ever looked at. Null when the event (or
 * its action) is acknowledged but posts nothing. The message posts under the
 * webhook's name: GitHub has no username override.
 */
function renderGitHubDelivery(req: Request<ExecuteParams>, res: Response, webhook: ExecutableWebhook): RenderedWebhookMessage | null {
  // Fail closed: a body the parser skipped (consumed upstream) never met the
  // verify hook, so no signature was checked over it
  if (localsOf(res).signatureVerified !== true) throw invalidSignature(webhook.id);

  // An empty header is no event either
  const event = req.get('x-github-event');
  if (!event) {
    throw new BadRequestError('This is a GitHub webhook; send GitHub deliveries (missing X-GitHub-Event)');
  }

  const result = renderGitHubEvent(event, req.body);
  if ('error' in result) throw new BadRequestError(result.error);
  if ('ignored' in result) return null;
  return { content: result.content };
}

/** The message content and name for this delivery, by webhook type; null
 *  when the delivery is acknowledged but posts nothing. */
function renderDelivery(req: Request<ExecuteParams>, res: Response, webhook: ExecutableWebhook): RenderedWebhookMessage | null {
  switch (webhook.type) {
    case 'generic': {
      if (req.get('x-github-event') !== undefined) {
        throw new BadRequestError('This is a generic webhook; create a GitHub webhook for GitHub deliveries');
      }
      const result = renderDiscordPayload(req.body);
      if ('error' in result) throw new BadRequestError(result.error);
      return result;
    }
    case 'github':
      return renderGitHubDelivery(req, res, webhook);
    default:
      throw new BadRequestError('Unsupported webhook type');
  }
}

/**
 * Throttled: one conditional write, a no-op within a minute of the last.
 * Runs only for an accepted delivery, after its message (if any) went out,
 * so a failure here is only logged.
 */
async function recordLastUsed(webhookId: string): Promise<void> {
  try {
    await prisma.webhook.updateMany({
      where: {
        id: webhookId,
        OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: new Date(Date.now() - LAST_USED_THROTTLE_MS) } }],
      },
      data: { lastUsedAt: new Date() },
    });
  } catch (err) {
    console.warn('[Webhooks] Could not record lastUsedAt', {
      webhookId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function executeWebhook(req: Request<ExecuteParams>, res: Response, next: NextFunction): Promise<void> {
  try {
    const webhook = res.locals.webhook as ExecutableWebhook;

    // The delivery id helps support match a GitHub delivery log; nothing else
    // from the request headers is ever logged
    const delivery = req.get('x-github-delivery');
    if (delivery) {
      console.debug('[Webhooks] GitHub delivery', { webhookId: webhook.id, delivery: delivery.slice(0, 64) });
    }

    const rendered = renderDelivery(req, res, webhook);
    if (rendered === null) {
      // Authentic but nothing to post (a GitHub event or action the formatter
      // ignores): no insert, no broadcast, but the list's "last used" moves
      await recordLastUsed(webhook.id);
      if (req.query.wait === 'true') {
        res.status(200).json({ success: true, data: null });
        return;
      }
      res.status(204).end();
      return;
    }
    const webhookName = rendered.nameOverride ?? webhook.name;

    // No authorId (the webhook is the author), type stays 'user', no replyTo,
    // and NO mention extraction: an unauthenticated URL must not ping anyone
    const created = await prisma.message
      .create({
        data: {
          content: rendered.content,
          channelId: webhook.channelId,
          webhookId: webhook.id,
          webhookName,
        },
        include: {
          author: authorSelect,
          attachments: attachmentSelect,
        },
      })
      .catch((err: unknown) => {
        // P2003: deleted between the token check and the insert — the answer
        // a deleted webhook gets, not a 500
        if (isForeignKeyViolation(err)) throw new NotFoundError('Webhook');
        throw err;
      });

    const message = { ...shapeMessageRow(created), replyTo: null, reactions: [], mentions: [] };
    const payload = {
      ...message,
      channelName: webhook.channel.name,
      serverName: webhook.channel.server.name,
      serverId: webhook.channel.serverId,
    };
    getIO().to(`channel:${webhook.channelId}`).emit('message:new', payload as unknown as Message);

    await recordLastUsed(webhook.id);

    if (req.query.wait === 'true') {
      res.status(200).json({ success: true, data: message });
      return;
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

export const webhookExecuteRouter = Router();

// Router level, so they run even when the route's param decoding throws
webhookExecuteRouter.use(executeRequestsOnly);
webhookExecuteRouter.use(requireFeature('webhooks', DISABLED_MESSAGE));
webhookExecuteRouter.use(rateLimitWebhookExecuteIp);

webhookExecuteRouter.post(
  '/:webhookId/:token',
  requireJson,
  loadWebhook,
  // Only now, on a validated token: its key is req.params.webhookId, which is
  // attacker-controlled until loadWebhook has checked the token
  rateLimitWebhookExecute,
  // Last guard before the handler: a body is read and parsed only for a
  // valid token, and a GitHub body only once its signature matched the raw
  // bytes (the verify hook runs between the read and the parse)
  express.json({ limit: LIMITS.WEBHOOK_BODY_MAX_BYTES, verify: verifyRawBody }),
  executeWebhook,
);
