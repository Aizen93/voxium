import { Router, type Request, type Response, type NextFunction } from 'express';
import crypto from 'crypto';
import { authenticate, requireVerifiedEmail, requireConsent } from '../middleware/auth';
import { requireFeature } from '../middleware/requireFeature';
import { rateLimitWebhookManage, rateLimitWebhookRead } from '../middleware/rateLimiter';
import { prisma } from '../utils/prisma';
import { BadRequestError, ForbiddenError, NotFoundError, ServiceUnavailableError } from '../utils/errors';
import { sanitizeText } from '../utils/sanitize';
import { isSecretBoxConfigured, sealSecret } from '../utils/secretBox';
import { getEffectiveLimits } from '../utils/serverLimits';
import { hasServerPermission, hasChannelPermission, filterVisibleChannels } from '../utils/permissionCalculator';
import {
  webhookSelect,
  toWebhook,
  isPurgeRequested,
  emitWebhookChanged,
  deleteWebhookWithPurge,
  emitWebhookDeletion,
} from '../utils/webhookLifecycle';
import {
  Permissions,
  WEBHOOK_TYPES,
  validateWebhookName,
  type WebhookType,
  // The shared DTO is aliased: Prisma's generated client exports a `Webhook`
  // model type of the same name.
  type Webhook as WebhookDto,
  type WebhookCreated,
} from '@voxium/shared';

/**
 * Incoming-webhook MANAGEMENT (authenticated): list, create, edit, rotate and
 * delete a server's webhooks. The public execute endpoint is a different
 * router (routes/webhookExecute.ts) mounted outside the api router.
 *
 * Mounted as `/servers/:serverId/webhooks` (mergeParams, like messages.ts),
 * behind the api router's rateLimitGeneral. Every route needs MANAGE_WEBHOOKS
 * (server-level only; owner and ADMINISTRATOR pass through the calculator),
 * and a webhook exists for the caller only if they can VIEW its channel.
 *
 * The token is the credential: 256 random bits, only its SHA-256 is stored,
 * and the plaintext leaves the server exactly twice: in the create and in the
 * rotate response. Never in a list, an edit, a socket event or a log line.
 *
 * A GitHub webhook also has a signing secret (the HMAC key GitHub signs each
 * delivery with): 32 random bytes as hex, generated here, stored ONLY sealed
 * (utils/secretBox.ts, AES-256-GCM under TOTP_ENCRYPTION_KEY) and shown under
 * the same rule as the token: in the create and the rotate response, nowhere
 * else. Without a usable key the server stores nothing and refuses (503)
 * before any write.
 */
export const webhookRouter = Router({ mergeParams: true });

webhookRouter.use(authenticate, requireVerifiedEmail, requireConsent);
webhookRouter.use(requireFeature('webhooks', 'Webhooks are currently disabled'));

// A non-member gets the same 403 as a member without the bit (the calculator
// answers 0n for non-members). Server existence is not secret on this route,
// exactly as on the channel-management routes.
webhookRouter.use(async (req: Request<{ serverId: string }>, _res: Response, next: NextFunction) => {
  try {
    const allowed = await hasServerPermission(req.user!.userId, req.params.serverId, Permissions.MANAGE_WEBHOOKS);
    if (!allowed) throw new ForbiddenError('You do not have permission to manage webhooks');
    next();
  } catch (err) {
    next(err);
  }
});

// ─── Internals ──────────────────────────────────────────────────────────────
// The response shape (webhookSelect / toWebhook), the refetch hint and the
// delete transaction live in utils/webhookLifecycle.ts: the platform-admin
// routes (routes/admin.ts) share them.

/** 32 random bytes = 43 base64url characters (URL-safe, no padding). */
function newToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/** What the database stores (sha256, hex), and what the execute route
 *  compares the presented token's hash against. */
function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

const GITHUB_UNCONFIGURED = 'GitHub webhooks are not configured on this server';

/** 503 unless a GitHub secret can be sealed: checked BEFORE anything is written. */
function assertSecretBox(): void {
  if (!isSecretBoxConfigured()) throw new ServiceUnavailableError(GITHUB_UNCONFIGURED);
}

/** A fresh GitHub signing secret (32 random bytes, 64 hex) and its sealed form. */
function newSecret(): { secret: string; secretEnc: string } {
  const secret = crypto.randomBytes(32).toString('hex');
  return { secret, secretEnc: sealSecret(secret) };
}

function isWebhookType(value: unknown): value is WebhookType {
  return typeof value === 'string' && (WEBHOOK_TYPES as readonly string[]).includes(value);
}

/** The parsed JSON body as a plain object, or {} (Express 5 leaves req.body
 *  undefined when no parser ran; an array body carries no fields). */
function bodyOf(body: unknown): Record<string, unknown> {
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

/**
 * A webhook may only target a TEXT channel of THIS server that is not secure
 * and that the caller can SEE.
 *
 * - A secure channel answers exactly like a nonexistent one (secure-channel
 *   opacity).
 * - A channel the caller cannot VIEW answers the same 404, as on every channel
 *   management route (channels.ts): a webhook URL is write access to its
 *   channel, and MANAGE_WEBHOOKS must not become a way to post into a
 *   staff-only channel its holder cannot see.
 * - Both are decided BEFORE the type check, so a hidden voice channel cannot
 *   leak "exists, but is voice".
 */
async function assertChannel(userId: string, serverId: string, channelId: string): Promise<void> {
  const channel = await prisma.channel.findUnique({
    where: { id: channelId },
    select: { id: true, serverId: true, type: true, secure: true },
  });
  if (!channel || channel.serverId !== serverId) throw new NotFoundError('Channel');
  if (channel.secure === true) throw new NotFoundError('Channel');
  if (!await hasChannelPermission(userId, channelId, serverId, Permissions.VIEW_CHANNEL)) {
    throw new NotFoundError('Channel');
  }
  if (channel.type !== 'text') throw new BadRequestError('Webhooks can only post to text channels');
}

/**
 * The webhook, if it belongs to this server AND posts to a channel the caller
 * can VIEW. Anything else answers exactly like a missing id: the list below
 * omits webhooks of hidden channels, and rotate would otherwise hand out a
 * working credential for a channel the caller cannot see.
 */
async function loadOwnWebhook(
  userId: string,
  serverId: string,
  webhookId: string,
): Promise<{ id: string; serverId: string; channelId: string; type: string }> {
  const webhook = await prisma.webhook.findUnique({
    where: { id: webhookId },
    select: { id: true, serverId: true, channelId: true, type: true },
  });
  if (!webhook || webhook.serverId !== serverId) throw new NotFoundError('Webhook');
  if (!await hasChannelPermission(userId, webhook.channelId, serverId, Permissions.VIEW_CHANNEL)) {
    throw new NotFoundError('Webhook');
  }
  return webhook;
}

/**
 * The write after loadOwnWebhook. A webhook deleted between that read and
 * this update (an admin delete racing an owner's rotate, or two moderators)
 * is Prisma's P2025: answer the missing webhook it now is, never a 500 with
 * a logged stack. The idiom of the admin PATCH (routes/admin.ts).
 */
async function updateOrMissing<T>(write: Promise<T>): Promise<T> {
  try {
    return await write;
  } catch (err) {
    if ((err as { code?: unknown })?.code === 'P2025') throw new NotFoundError('Webhook');
    throw err;
  }
}

// ─── Routes ─────────────────────────────────────────────────────────────────

// List the server's webhooks on channels the caller can VIEW. Inherently
// bounded by the per-server cap (admin maximum 100).
//
// `total` is EVERY webhook of the server, hidden channels included: the cap
// the create route enforces counts them all, so the tab's "N of M" and its
// "New webhook" gate must too (a moderator who cannot see some channels would
// otherwise read "3 of 10" on a full server). A count reveals no channel id
// or name, only how many exist. It is the length of the unfiltered read
// below, which IS `count({ where: { serverId } })` from the same snapshot,
// without a second query; that read must therefore stay unpaginated.
webhookRouter.get('/', rateLimitWebhookRead, async (req: Request<{ serverId: string }>, res: Response, next: NextFunction) => {
  try {
    const { serverId } = req.params;
    const userId = req.user!.userId;
    const rows = await prisma.webhook.findMany({
      where: { serverId },
      orderBy: { createdAt: 'asc' },
      // `secure` MUST be selected for the visibility filter (it fails open
      // without it). Webhooks never target secure channels; this is defence.
      select: { ...webhookSelect, channel: { select: { id: true, secure: true } } },
    });
    let data: WebhookDto[] = [];
    if (rows.length > 0) {
      const visible = new Set(
        (await filterVisibleChannels(userId, serverId, rows.map((r) => r.channel))).map((c) => c.id),
      );
      data = rows.filter((r) => visible.has(r.channelId)).map(toWebhook);
    }
    res.json({ success: true, data, total: rows.length });
  } catch (err) {
    next(err);
  }
});

// Create a webhook. Besides rotate, the ONLY response that carries the token.
webhookRouter.post('/', rateLimitWebhookManage, async (req: Request<{ serverId: string }>, res: Response, next: NextFunction) => {
  try {
    const { serverId } = req.params;
    const userId = req.user!.userId;
    const body = bodyOf(req.body);

    const channelId = body.channelId;
    if (typeof channelId !== 'string' || channelId.length === 0) {
      throw new BadRequestError('channelId is required');
    }

    const type = body.type;
    if (!isWebhookType(type)) throw new BadRequestError('Invalid webhook type');
    // Before the cap and the create: an unconfigured server consumes nothing
    if (type === 'github') assertSecretBox();

    const name = sanitizeText(body.name);
    const nameErr = validateWebhookName(name);
    if (nameErr) throw new BadRequestError(nameErr);

    await assertChannel(userId, serverId, channelId);

    // Count-then-create, like the channel cap (channels.ts): two concurrent
    // creates can overshoot the cap by one. A cap of 0 freezes creation.
    const [count, limits] = await Promise.all([
      prisma.webhook.count({ where: { serverId } }),
      getEffectiveLimits(serverId),
    ]);
    if (count >= limits.maxWebhooksPerServer) {
      throw new BadRequestError(`Server can have at most ${limits.maxWebhooksPerServer} webhooks`);
    }

    const token = newToken();
    // A generic webhook has no secret; a GitHub one stores only the sealed form
    const signing = type === 'github' ? newSecret() : null;
    const row = await prisma.webhook.create({
      data: {
        serverId,
        channelId,
        name,
        type,
        tokenHash: hashToken(token),
        secretEnc: signing ? signing.secretEnc : null,
        createdById: userId,
      },
      select: webhookSelect,
    });

    emitWebhookChanged(serverId);

    // The public URL is composed by the CLIENT from its own API base
    // (`${VITE_API_URL}/webhooks/${id}/${token}`): the server does not know
    // its public origin, and deriving it from the request depends on proxies.
    const data: WebhookCreated = signing
      ? { ...toWebhook(row), token, secret: signing.secret }
      : { ...toWebhook(row), token };
    res.status(201).json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// Edit name / target channel / enabled. Moving a webhook moves nothing it
// already posted: its old messages stay where they are.
webhookRouter.patch('/:webhookId', rateLimitWebhookManage, async (req: Request<{ serverId: string; webhookId: string }>, res: Response, next: NextFunction) => {
  try {
    const { serverId, webhookId } = req.params;
    const userId = req.user!.userId;
    const body = bodyOf(req.body);
    const data: { name?: string; channelId?: string; enabled?: boolean } = {};

    if (body.name !== undefined) {
      const name = sanitizeText(body.name);
      const nameErr = validateWebhookName(name);
      if (nameErr) throw new BadRequestError(nameErr);
      data.name = name;
    }
    if (body.channelId !== undefined) {
      if (typeof body.channelId !== 'string' || body.channelId.length === 0) {
        throw new BadRequestError('channelId must be a non-empty string');
      }
      data.channelId = body.channelId;
    }
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') throw new BadRequestError('enabled must be a boolean');
      data.enabled = body.enabled;
    }
    if (Object.keys(data).length === 0) throw new BadRequestError('No fields to update');

    await loadOwnWebhook(userId, serverId, webhookId);
    if (data.channelId !== undefined) await assertChannel(userId, serverId, data.channelId);

    const row = await updateOrMissing(prisma.webhook.update({
      where: { id: webhookId },
      data,
      select: webhookSelect,
    }));

    emitWebhookChanged(serverId);

    const out: WebhookDto = toWebhook(row);
    res.json({ success: true, data: out });
  } catch (err) {
    next(err);
  }
});

// Rotate the token, and for a GitHub webhook its signing secret too:
// rotation renews both, in one update. Only the hash and the sealed secret
// are stored, so the old credentials stop working the moment it commits.
webhookRouter.post('/:webhookId/rotate', rateLimitWebhookManage, async (req: Request<{ serverId: string; webhookId: string }>, res: Response, next: NextFunction) => {
  try {
    const { serverId, webhookId } = req.params;
    const webhook = await loadOwnWebhook(req.user!.userId, serverId, webhookId);
    const isGitHub = webhook.type === 'github';
    // Before the update: without a key nothing is rotated, the old pair stays
    if (isGitHub) assertSecretBox();

    const token = newToken();
    const signing = isGitHub ? newSecret() : null;
    const row = await updateOrMissing(prisma.webhook.update({
      where: { id: webhookId },
      data: signing
        ? { tokenHash: hashToken(token), secretEnc: signing.secretEnc }
        : { tokenHash: hashToken(token) },
      select: webhookSelect,
    }));

    emitWebhookChanged(serverId);

    const data: WebhookCreated = signing
      ? { ...toWebhook(row), token, secret: signing.secret }
      : { ...toWebhook(row), token };
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// Delete a webhook; `?purge=1` (or `true`) also deletes EVERY message it
// posted, in every channel (PATCH may have moved it since), in the same
// transaction. Without purge its messages stay, labelled with the stored
// webhookName (webhookId SetNull). The transaction (row lock first) and the
// receipts are utils/webhookLifecycle.ts, shared with the admin delete.
webhookRouter.delete('/:webhookId', rateLimitWebhookManage, async (req: Request<{ serverId: string; webhookId: string }>, res: Response, next: NextFunction) => {
  try {
    const { serverId, webhookId } = req.params;
    const purge = isPurgeRequested(req.query.purge);
    const webhook = await loadOwnWebhook(req.user!.userId, serverId, webhookId);

    const result = await deleteWebhookWithPurge(webhook.id, purge);
    // No locked row: a concurrent delete won the lock and already committed
    if (!result) throw new NotFoundError('Webhook');

    emitWebhookDeletion(result, purge);

    res.json({ success: true, data: { deletedMessages: result.deletedMessages } });
  } catch (err) {
    next(err);
  }
});
