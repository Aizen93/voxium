import crypto from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import express, { Router, type Request, type Response, type NextFunction } from 'express';
import { LIMITS, type Message } from '@voxium/shared';
import type { Prisma } from '../generated/prisma/client';
import { prisma } from '../utils/prisma';
import { getIO } from '../websocket/socketServer';
import { requireFeature } from '../middleware/requireFeature';
import { rateLimitWebhookExecute, rateLimitWebhookExecuteIp } from '../middleware/rateLimiter';
import { BadRequestError, ForbiddenError, NotFoundError, UnsupportedMediaTypeError } from '../utils/errors';
import { shapeMessageRow } from '../utils/messageAuthor';
import { renderDiscordPayload, type RenderedWebhookMessage } from '../utils/webhooks/discordPayload';

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
 *                  → per-webhook limiter → body parser → render + insert + broadcast
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

/** Keeps the exact request bytes for the GitHub signature check (step 3). */
function keepRawBody(req: IncomingMessage, _res: ServerResponse, buf: Buffer): void {
  (req as Request).rawBody = buf;
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
    res.locals.webhook = webhook;
    next();
  } catch (err) {
    next(err);
  }
}

/** The message content and name for this delivery, by webhook type. */
function renderDelivery(req: Request<ExecuteParams>, webhook: ExecutableWebhook): RenderedWebhookMessage {
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
      // Step 3 replaces this branch: X-Hub-Signature-256 verified over
      // req.rawBody with the opened secret, then the GitHub formatter
      throw new BadRequestError('GitHub webhooks are not supported yet');
    default:
      throw new BadRequestError('Unsupported webhook type');
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

    const rendered = renderDelivery(req, webhook);
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

    // Throttled: one conditional write, a no-op within a minute of the last.
    // The message is already delivered, so a failure here is only logged
    try {
      await prisma.webhook.updateMany({
        where: {
          id: webhook.id,
          OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: new Date(Date.now() - LAST_USED_THROTTLE_MS) } }],
        },
        data: { lastUsedAt: new Date() },
      });
    } catch (err) {
      console.warn('[Webhooks] Could not record lastUsedAt', {
        webhookId: webhook.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }

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
  // valid token (req.rawBody still exists for the handler's signature check)
  express.json({ limit: LIMITS.WEBHOOK_BODY_MAX_BYTES, verify: keepRawBody }),
  executeWebhook,
);
