import { Router, type Request, type Response, type NextFunction } from 'express';
import crypto from 'crypto';
import { authenticate, requireVerifiedEmail, requireConsent } from '../middleware/auth';
import { requireFeature } from '../middleware/requireFeature';
import { rateLimitWebhookManage, rateLimitWebhookRead } from '../middleware/rateLimiter';
import { prisma } from '../utils/prisma';
import { BadRequestError, ForbiddenError, NotFoundError, ServiceUnavailableError, prismaErrorCode, violatesForeignKey } from '../utils/errors';
import { sanitizeText } from '../utils/sanitize';
import { newWebhookToken, hashWebhookTokenHex } from '../utils/webhookToken';
import { isSecretBoxConfigured, sealSecret } from '../utils/secretBox';
import { getEffectiveLimits } from '../utils/serverLimits';
import { LOCK_WAIT_TRANSACTION_OPTIONS, retryOnTransactionConflict } from '../utils/transactionRetry';
import {
  hasServerPermission,
  hasChannelPermission,
  filterVisibleChannels,
  filterChannelsWithPermissions,
  type ChannelPermissionReadClient,
  type PermissionReadClient,
} from '../utils/permissionCalculator';
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
  WEBHOOKS_DISABLED_MESSAGE,
  validateWebhookName,
  type WebhookType,
  // The shared DTO is aliased: Prisma's generated client exports a `Webhook`
  // model type of the same name.
  type Webhook as WebhookDto,
  type WebhookCreated,
  type WebhookTarget,
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
 * Whatever turns the URL into write access to a channel also asks
 * SEND_MESSAGES there, after VIEW (so a hidden channel stays a 404): create,
 * a move, a rotate and an ENABLE. A rename or a disable asks neither. The
 * create/move check is assertChannel; `GET /targets` lists exactly the
 * channels it would accept, so the picker never offers a refused one.
 *
 * A platform admin's disable is sticky (`adminDisabledAt`, set by
 * routes/admin.ts): while it is set the owner's enable answers 403 and only an
 * admin's enable lifts it. A rename, a move or a disable stays allowed. A
 * kick or ban disables the webhooks whose live URL the member holds (created
 * by them and never rotated by another, or last rotated by them) and marks
 * them (`creatorRemovedAt`, utils/removeMember.ts): any enable, the owner's
 * or an admin's, or a rotate clears the mark, as having reviewed it. A
 * create, a rotate and an enable run under the caller's member row
 * (lockCallerMemberRow): only a current member who may manage webhooks makes,
 * re-mints or re-arms a URL.
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
webhookRouter.use(requireFeature('webhooks', WEBHOOKS_DISABLED_MESSAGE));

// A non-member gets the same 403 as a member without the bit (the calculator
// answers 0n for non-members). Server existence is not secret on this route,
// exactly as on the channel-management routes.
webhookRouter.use(async (req: Request<{ serverId: string }>, _res: Response, next: NextFunction) => {
  try {
    const allowed = await hasServerPermission(req.user!.userId, req.params.serverId, Permissions.MANAGE_WEBHOOKS);
    if (!allowed) throw new ForbiddenError(NO_MANAGE);
    next();
  } catch (err) {
    next(err);
  }
});

// ─── Internals ──────────────────────────────────────────────────────────────
// The response shape (webhookSelect / toWebhook), the refetch hint and the
// delete transaction live in utils/webhookLifecycle.ts: the platform-admin
// routes (routes/admin.ts) share them.

// The token (32 random bytes, base64url) and its stored SHA-256 come from
// utils/webhookToken.ts, shared with the execute route's check.

const GITHUB_UNCONFIGURED = 'GitHub webhooks are not configured on this server';
// routes/messages.ts answers the same sentence for a refused SEND_MESSAGES
const NO_SEND = 'You do not have permission to send messages in this channel';
const ADMIN_DISABLED = 'This webhook was disabled by an administrator';
const NO_MANAGE = 'You do not have permission to manage webhooks';

/**
 * A webhook is created, rotated or enabled only by a current member who may
 * manage webhooks, checked under the member row. The transaction's first
 * statement locks the caller's member row FOR KEY SHARE; a removal of the
 * caller locks that row FOR UPDATE as its first statement, so the two queue
 * on it. A removal that commits first leaves no row, and the check that
 * follows (refuseUnlessManager) refuses; a removal that waits reads the
 * webhook this transaction commits, and its webhook statement disables it
 * with the others the member holds.
 *
 * A rotate and an enable then write the webhook row (an enable that moves
 * the webhook also key-shares the target channel). A removal and an account
 * deletion take the member row first too; a channel delete, a purge-delete
 * and a platform ban's disarm take no member row. A space delete reaches its
 * rows in the order PostgreSQL fires the cascade triggers of `servers` in,
 * which is the text order of the trigger names (each ends in the trigger's
 * oid), not an order the schema fixes: on a restored database, or one whose
 * oid counter was further along when a table was added, the delete can hold
 * the webhook row or the target channel while it waits for the member row.
 * So both run inside retryOnTransactionConflict, with their checks made
 * again on every attempt (assertMayArm); an attempt after the delete has
 * committed answers 404 Server.
 */
async function lockCallerMemberRow(tx: { $queryRaw: typeof prisma.$queryRaw }, userId: string, serverId: string): Promise<void> {
  await tx.$queryRaw`SELECT user_id FROM server_members WHERE user_id = ${userId} AND server_id = ${serverId} FOR KEY SHARE`;
}

/**
 * The webhook-management permission read again on `db` (a transaction's
 * client, after lockCallerMemberRow): 404 Server when the space is gone,
 * otherwise the router's own 403 for a caller who is not a member or lacks
 * the permission.
 */
async function refuseUnlessManager(db: PermissionReadClient, userId: string, serverId: string): Promise<void> {
  if (await hasServerPermission(userId, serverId, Permissions.MANAGE_WEBHOOKS, db)) return;
  const space = await db.server.findUnique({ where: { id: serverId }, select: { id: true } });
  if (!space) throw new NotFoundError('Server');
  throw new ForbiddenError(NO_MANAGE);
}

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
 * A webhook may only target a TEXT channel of THIS server that is not secure,
 * that the caller can SEE, and that the caller may SEND messages in.
 *
 * - A secure channel answers exactly like a nonexistent one (secure-channel
 *   opacity).
 * - A channel the caller cannot VIEW answers the same 404, as on every channel
 *   management route (channels.ts): a webhook URL is write access to its
 *   channel, and MANAGE_WEBHOOKS must not become a way to post into a
 *   staff-only channel its holder cannot see.
 * - A channel the caller can see but not post in (a read-only announcements
 *   channel) is a 403 with the sentence routes/messages.ts answers: a webhook
 *   posts there under any name its sender picks, so MANAGE_WEBHOOKS must not
 *   become a way around SEND_MESSAGES either. Owner and ADMINISTRATOR pass
 *   through the calculator.
 * - All three are decided BEFORE the type check, so a hidden voice channel
 *   cannot leak "exists, but is voice".
 *
 * Reads through `db` when one is given (a transaction's client: the
 * creation asks it again inside its transaction, on every attempt).
 */
async function assertChannel(userId: string, serverId: string, channelId: string, db?: ChannelPermissionReadClient): Promise<void> {
  const channel = await (db ?? prisma).channel.findUnique({
    where: { id: channelId },
    select: { id: true, serverId: true, type: true, secure: true },
  });
  if (!channel || channel.serverId !== serverId) throw new NotFoundError('Channel');
  if (channel.secure === true) throw new NotFoundError('Channel');
  if (!await hasChannelPermission(userId, channelId, serverId, Permissions.VIEW_CHANNEL, db)) {
    throw new NotFoundError('Channel');
  }
  if (!await hasChannelPermission(userId, channelId, serverId, Permissions.SEND_MESSAGES, db)) {
    throw new ForbiddenError(NO_SEND);
  }
  if (channel.type !== 'text') throw new BadRequestError('Webhooks can only post to text channels');
}

/**
 * The webhook, if it belongs to this server AND posts to a channel the caller
 * can VIEW. Anything else answers exactly like a missing id: the list below
 * omits webhooks of hidden channels, and rotate would otherwise hand out a
 * working credential for a channel the caller cannot see (rotate and an
 * enable then ask SEND_MESSAGES on their own, as create and a move do).
 * `adminDisabledAt` is the sticky admin lock the PATCH enforces.
 */
async function loadOwnWebhook(
  userId: string,
  serverId: string,
  webhookId: string,
): Promise<{ id: string; serverId: string; channelId: string; type: string; adminDisabledAt: Date | null }> {
  const webhook = await prisma.webhook.findUnique({
    where: { id: webhookId },
    select: { id: true, serverId: true, channelId: true, type: true, adminDisabledAt: true },
  });
  if (!webhook || webhook.serverId !== serverId) throw new NotFoundError('Webhook');
  if (!await hasChannelPermission(userId, webhook.channelId, serverId, Permissions.VIEW_CHANNEL)) {
    throw new NotFoundError('Webhook');
  }
  return webhook;
}

/**
 * The channel checks a rotate or an enable made before its transaction, made
 * again on the transaction's client (`db`), on every attempt: the caller
 * still sees the webhook's channel (otherwise the webhook answers as a
 * missing one, as loadOwnWebhook does) and may still send where the URL will
 * post: in that channel, or, for an enable that also moves the webhook, in
 * `target` (assertChannel, every check of a move). The write itself is
 * conditional on the webhook still posting to `channelId`.
 */
async function assertMayArm(
  db: ChannelPermissionReadClient,
  userId: string,
  serverId: string,
  channelId: string,
  target?: string,
): Promise<void> {
  if (!await hasChannelPermission(userId, channelId, serverId, Permissions.VIEW_CHANNEL, db)) {
    throw new NotFoundError('Webhook');
  }
  if (target !== undefined) {
    await assertChannel(userId, serverId, target, db);
    return;
  }
  if (!await hasChannelPermission(userId, channelId, serverId, Permissions.SEND_MESSAGES, db)) {
    throw new ForbiddenError(NO_SEND);
  }
}

/**
 * A webhook write's foreign-key refusal (P2003), answered by the key the
 * driver names. The space's key (the space deleted meanwhile) answers the
 * missing space it now is. The channel's key (the channel deleted between
 * assertChannel and the write) answers the missing channel. The caller's own
 * key, the creator's on a create and the rotator's on a rotate (the caller's
 * account deleted meanwhile), answers the missing user. Anything else is
 * thrown as it is.
 */
function foreignKeyRefusedAsNotFound(err: unknown): never {
  if (violatesForeignKey(err, 'webhooks_server_id_fkey')) throw new NotFoundError('Server');
  if (violatesForeignKey(err, 'webhooks_channel_id_fkey')) throw new NotFoundError('Channel');
  if (violatesForeignKey(err, 'webhooks_created_by_id_fkey') || violatesForeignKey(err, 'webhooks_last_rotated_by_id_fkey')) {
    throw new NotFoundError('User');
  }
  throw err;
}

/**
 * The write after loadOwnWebhook, made CONDITIONAL on the channel that read
 * checked VIEW on (`where: { id, channelId }`; Prisma accepts extra filters
 * beside the unique id). Its P2025 is answered as the missing webhook it now
 * is, never a 500 with a logged stack (the idiom of the admin PATCH,
 * routes/admin.ts), for either race:
 * - the webhook was deleted meanwhile (an admin delete racing an owner's
 *   rotate, or two moderators);
 * - another moderator MOVED it meanwhile, maybe into a channel this caller
 *   cannot see: the write matches nothing, so a rotate never hands out a
 *   working token for a hidden channel, and a PATCH never edits one.
 * A P2003 is answered by the key it names (foreignKeyRefusedAsNotFound): a
 * PATCH's target channel deleted meanwhile, a rotate's caller deleted meanwhile.
 */
async function updateOrMissing<T>(write: Promise<T>): Promise<T> {
  try {
    return await write;
  } catch (err) {
    if (prismaErrorCode(err) === 'P2025') throw new NotFoundError('Webhook');
    return foreignKeyRefusedAsNotFound(err);
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

// The channels THIS caller may bind a webhook to, decided as assertChannel
// decides for a create or a move: a non-secure TEXT channel of the server
// that the caller can VIEW and SEND_MESSAGES in. The picker offers these and
// nothing else, so it never offers a channel the write would refuse, nor
// names one the caller cannot see. Registered BEFORE the `/:webhookId` routes.
//
// One batched permission pass for the whole list (VIEW and SEND together),
// never a permission computation per channel: at the admin's channel cap a
// per-channel check would be thousands of queries per call.
webhookRouter.get('/targets', rateLimitWebhookRead, async (req: Request<{ serverId: string }>, res: Response, next: NextFunction) => {
  try {
    const { serverId } = req.params;
    const userId = req.user!.userId;
    const channels = await prisma.channel.findMany({
      where: { serverId, type: 'text', secure: false },
      orderBy: [{ position: 'asc' }, { name: 'asc' }],
      // `secure` MUST be selected for the visibility filter (it fails open
      // without it), although the query already excludes secure channels
      select: { id: true, name: true, categoryId: true, position: true, type: true, secure: true },
    });
    // The where clause again, in code: what this route answers must never
    // rest on a query filter alone (secure-channel opacity)
    const candidates = channels.filter((c) => c.type === 'text' && c.secure === false);
    const allowed = candidates.length > 0
      ? await filterChannelsWithPermissions(userId, serverId, candidates, Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES)
      : [];
    const data: WebhookTarget[] = allowed.map((c) => ({ id: c.id, name: c.name, categoryId: c.categoryId, position: c.position }));
    res.json({ success: true, data });
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

    const limits = await getEffectiveLimits(serverId);
    const token = newWebhookToken();
    // A generic webhook has no secret; a GitHub one stores only the sealed form
    const signing = type === 'github' ? newSecret() : null;

    // Count-then-create under a row lock on the SERVER, so concurrent creates
    // for one server run one after the other and each counts the ones before
    // it: the cap holds exactly (a cap of 0 freezes creation). The channel,
    // secure-channel and category creations take the same lock for theirs.
    // The long budget (LOCK_WAIT_TRANSACTION_OPTIONS): a space delete holds
    // the space row through its cascade (every channel and message of the
    // space), and a creation merely waiting for it must not expire. Run again
    // whole when PostgreSQL aborts it to break a deadlock, as every creation
    // under the space row lock is: an aborted attempt leaves nothing, and the
    // count is read again under the lock. Each attempt first waits, holding
    // nothing, for the existing rows the insert key-shares after the space
    // row (the channel, the creator's account), one statement each on the
    // shared client and outside any transaction, so a transaction holding
    // one of them (a channel delete, an account deletion of the creator) is
    // waited for before the space row is taken.
    const row = await retryOnTransactionConflict(async () => {
      await prisma.$queryRaw`SELECT id FROM channels WHERE id = ${channelId} FOR KEY SHARE`;
      await prisma.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR KEY SHARE`;
      return prisma.$transaction(async (tx) => {
        // The caller's member row first (lockCallerMemberRow), then the space
        // row: the order a secure-channel creation takes them in. A space
        // delete takes the space row and then, through its cascade, the
        // member rows: when it reaches the caller's row after this
        // transaction locked it, PostgreSQL aborts one side; both are retried,
        // and the creation's retry answers 404 Server.
        await lockCallerMemberRow(tx, userId, serverId);
        // Every check made before the transaction, made again on its client:
        // the permission, then the channel (assertChannel). Before the space
        // row is taken: they need nothing that row gives, and every join,
        // removal and creation of the space queues on it.
        await refuseUnlessManager(tx, userId, serverId);
        await assertChannel(userId, serverId, channelId, tx);
        // A space deleted since the checks answers as one
        const space = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM servers WHERE id = ${serverId} FOR UPDATE`;
        if (space.length === 0) throw new NotFoundError('Server');
        const count = await tx.webhook.count({ where: { serverId } });
        if (count >= limits.maxWebhooksPerServer) {
          throw new BadRequestError(`Server can have at most ${limits.maxWebhooksPerServer} webhooks`);
        }
        return tx.webhook.create({
          data: {
            serverId,
            channelId,
            name,
            type,
            tokenHash: hashWebhookTokenHex(token),
            secretEnc: signing ? signing.secretEnc : null,
            createdById: userId,
          },
          select: webhookSelect,
        });
      }, LOCK_WAIT_TRANSACTION_OPTIONS);
    }, `[Webhooks] The creation of a webhook in ${serverId}`).catch(foreignKeyRefusedAsNotFound);

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
//
// Order: loadOwnWebhook (VIEW) -> the admin lock -> SEND for an enable in
// place -> assertChannel for a move -> the write.
// - An enable while a platform admin's disable is in force is a 403, and
//   nothing is written: only an admin's enable lifts it. Renaming, moving or
//   disabling the locked webhook stays allowed (none of them reopens it).
// - An enable turns the URL back into write access to the webhook's channel,
//   so it asks SEND_MESSAGES there, as a rotate does. An enable that also
//   moves is asked on the TARGET, by assertChannel.
// - An enable clears `creatorRemovedAt`: the owner reviewed the webhook the
//   creator's removal disabled.
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

    const webhook = await loadOwnWebhook(userId, serverId, webhookId);
    const enabling = data.enabled === true;
    if (enabling && webhook.adminDisabledAt) throw new ForbiddenError(ADMIN_DISABLED);
    if (enabling && data.channelId === undefined
      && !await hasChannelPermission(userId, webhook.channelId, serverId, Permissions.SEND_MESSAGES)) {
      throw new ForbiddenError(NO_SEND);
    }
    if (data.channelId !== undefined) await assertChannel(userId, serverId, data.channelId);

    // Only if it still posts to the channel loadOwnWebhook checked VIEW on.
    // An enable is also conditional on the admin lock still being absent: an
    // admin disable landing after the check above makes the write match
    // nothing (the 404 of any row that changed under the caller), so the lock
    // never ends up set on an enabled webhook.
    const write = (db: Pick<typeof prisma, 'webhook'>) => updateOrMissing(db.webhook.update({
      where: enabling
        ? { id: webhookId, channelId: webhook.channelId, adminDisabledAt: null }
        : { id: webhookId, channelId: webhook.channelId },
      data: enabling ? { ...data, creatorRemovedAt: null } : data,
      select: webhookSelect,
    }));
    // An enable re-arms the webhook's URL: under the caller's member row,
    // after the permission and the channel checks read again there
    // (lockCallerMemberRow, assertMayArm), and run again whole when
    // PostgreSQL aborts it to break a deadlock. A rename, a move or a disable
    // is the one statement.
    const row = enabling
      ? await retryOnTransactionConflict(() => prisma.$transaction(async (tx) => {
        await lockCallerMemberRow(tx, userId, serverId);
        await refuseUnlessManager(tx, userId, serverId);
        await assertMayArm(tx, userId, serverId, webhook.channelId, data.channelId);
        return write(tx);
      }, LOCK_WAIT_TRANSACTION_OPTIONS), `[Webhooks] The enabling of ${webhookId}`)
      : await write(prisma);

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
    // Rotate hands out a working credential for the webhook's channel, so it
    // asks what create and a move ask: that the caller may SEND there (a
    // read-only announcements channel a moderator can see but not post in).
    // After VIEW (loadOwnWebhook), so a hidden channel's opacity is unchanged;
    // a rename or a disable asks neither (they mint nothing, reopen nothing).
    if (!await hasChannelPermission(req.user!.userId, webhook.channelId, serverId, Permissions.SEND_MESSAGES)) {
      throw new ForbiddenError(NO_SEND);
    }
    const isGitHub = webhook.type === 'github';
    // Before the update: without a key nothing is rotated, the old pair stays
    if (isGitHub) assertSecretBox();

    const token = newWebhookToken();
    const signing = isGitHub ? newSecret() : null;
    // Who rotated and when (shown on the tab), and the creator-removal mark
    // cleared: a rotate is the owner's answer to a URL that may have left with
    // a kicked creator. It never touches `enabled` nor the admin lock: a
    // webhook the kick disabled stays disabled until the owner enables it.
    const trace = { lastRotatedAt: new Date(), lastRotatedById: req.user!.userId, creatorRemovedAt: null };
    // Only if it still posts to the channel loadOwnWebhook checked VIEW on:
    // a webhook moved meanwhile into a channel this caller cannot see must
    // not hand them a working token for it
    // Under the caller's member row, after the permission and the channel
    // checks read again there (lockCallerMemberRow, assertMayArm), and run
    // again whole when PostgreSQL aborts it to break a deadlock: the same
    // token on every attempt, so the one that commits is the one answered
    const row = await retryOnTransactionConflict(() => prisma.$transaction(async (tx) => {
      await lockCallerMemberRow(tx, req.user!.userId, serverId);
      await refuseUnlessManager(tx, req.user!.userId, serverId);
      await assertMayArm(tx, req.user!.userId, serverId, webhook.channelId);
      return updateOrMissing(tx.webhook.update({
        where: { id: webhookId, channelId: webhook.channelId },
        data: signing
          ? { tokenHash: hashWebhookTokenHex(token), secretEnc: signing.secretEnc, ...trace }
          : { tokenHash: hashWebhookTokenHex(token), ...trace },
        select: webhookSelect,
      }));
    }, LOCK_WAIT_TRANSACTION_OPTIONS), `[Webhooks] The rotation of ${webhookId}`);

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
