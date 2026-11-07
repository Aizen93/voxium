import { WS_EVENTS, type Webhook as WebhookDto, type WebhookType } from '@voxium/shared';
import { prisma } from './prisma';
import { getIO } from '../websocket/socketServer';

/**
 * The webhook lifecycle both management surfaces share: the owner's router
 * (routes/webhooks.ts, MANAGE_WEBHOOKS + VIEW_CHANNEL) and the platform-admin
 * routes (routes/admin.ts). One response shape, one refetch hint, one delete
 * transaction: an admin delete locks, purges and announces exactly like an
 * owner's. Each caller keeps its own authorization; nothing here checks any.
 */

/** What any management response may show. NEVER tokenHash, NEVER secretEnc. */
export const webhookSelect = {
  id: true,
  serverId: true,
  channelId: true,
  name: true,
  type: true,
  enabled: true,
  adminDisabledAt: true,
  creatorRemovedAt: true,
  createdAt: true,
  lastUsedAt: true,
  lastRotatedAt: true,
  createdBy: { select: { id: true, username: true, displayName: true } },
  lastRotatedBy: { select: { id: true, username: true, displayName: true } },
} as const;

export interface WebhookRow {
  id: string;
  serverId: string;
  channelId: string;
  name: string;
  type: string;
  enabled: boolean;
  adminDisabledAt: Date | null;
  creatorRemovedAt: Date | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  lastRotatedAt: Date | null;
  createdBy: { id: string; username: string; displayName: string } | null;
  lastRotatedBy: { id: string; username: string; displayName: string } | null;
}

export function toWebhook(row: WebhookRow): WebhookDto {
  return {
    id: row.id,
    serverId: row.serverId,
    channelId: row.channelId,
    name: row.name,
    // Only the management router writes the column, and only WEBHOOK_TYPES values
    type: row.type as WebhookType,
    enabled: row.enabled,
    adminDisabledAt: row.adminDisabledAt ? row.adminDisabledAt.toISOString() : null,
    creatorRemovedAt: row.creatorRemovedAt ? row.creatorRemovedAt.toISOString() : null,
    createdBy: row.createdBy
      ? { id: row.createdBy.id, username: row.createdBy.username, displayName: row.createdBy.displayName }
      : null,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    lastRotatedAt: row.lastRotatedAt ? row.lastRotatedAt.toISOString() : null,
    lastRotatedBy: row.lastRotatedBy
      ? { id: row.lastRotatedBy.id, username: row.lastRotatedBy.username, displayName: row.lastRotatedBy.displayName }
      : null,
  };
}

/** `?purge=1` or `?purge=true`, exactly; anything else keeps the messages. */
export function isPurgeRequested(value: unknown): boolean {
  return value === '1' || value === 'true';
}

/**
 * Refetch hint for open Integrations tabs. The payload carries the server id
 * and NOTHING else: `channel:{id}` is the VIEW_CHANNEL boundary, and a
 * restricted channel's id (or a webhook's name) must never reach the
 * server-wide room. The token never travels on a socket.
 */
export function emitWebhookChanged(serverId: string): void {
  getIO().to(`server:${serverId}`).emit(WS_EVENTS.WEBHOOK_CHANGED, { serverId });
}

/** What a committed delete removed: the webhook as its lock found it, and the
 *  messages a purge took with it, per channel. */
export interface WebhookDeletion {
  webhookId: string;
  serverId: string;
  /** The channel the webhook posted to when it was deleted. */
  channelId: string;
  name: string;
  type: WebhookType;
  deletedMessages: number;
  /** Only channels that lost rows (empty without purge, or when a purge found nothing). */
  perChannel: Array<{ channelId: string; count: number }>;
}

/**
 * Delete a webhook; with `purge`, also EVERY message it posted, in every
 * channel (a PATCH may have moved it since), in the same transaction. Without
 * purge its messages stay, labelled with the stored webhookName (webhookId
 * SetNull). Resolves null when the lock finds no row: it never existed, or a
 * concurrent delete won the lock and already committed.
 *
 * No blob cleanup: the execute path never creates attachments, reactions
 * cascade with the message and replies SetNull. The purge (like the FK's SET
 * NULL action) finds the rows through the messages(webhook_id) index.
 *
 * The webhook is DISABLED first, in its own committed write, before the
 * transaction: the delete may hold the row lock for a long time (see the
 * timeout below), and a delivery arriving meanwhile then answers 403 at the
 * execute route's token check (it reads `enabled` without a lock) instead of
 * queueing an INSERT on that lock, one held connection per delivery. A
 * vanished row makes this a count-0 no-op: the lock below then finds nothing
 * and the caller answers 404. If the transaction fails, the webhook stays
 * disabled: the safe direction for a webhook someone asked to delete.
 *
 * Then the HISTORY goes in bounded batches with NO lock held (see
 * detachOrPurgeInBatches): a busy webhook posts 43k rows a day at its cap, and
 * rewriting or deleting hundreds of thousands of rows inside the locked
 * transaction would blow its 60 s budget on every retry (P2028), leaving a
 * webhook that can never be deleted. The transaction below then meets only
 * the rows that were in flight.
 */
export async function deleteWebhookWithPurge(webhookId: string, purge: boolean): Promise<WebhookDeletion | null> {
  await prisma.webhook.updateMany({ where: { id: webhookId }, data: { enabled: false } });

  const batched = await detachOrPurgeInBatches(webhookId, purge);

  return prisma.$transaction(async (tx) => {
    // Lock the webhook row FIRST. A concurrent delivery's INSERT takes a KEY
    // SHARE lock on it (the FK check), so it waits for this commit and then
    // fails its FK: no message can land between the purge and the delete.
    const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM webhooks WHERE id = ${webhookId} FOR UPDATE`;
    if (locked.length === 0) return null;

    // Read under the lock: the row this transaction deletes, which no
    // concurrent PATCH can move any more
    const row = await tx.webhook.findUnique({
      where: { id: webhookId },
      select: { serverId: true, channelId: true, name: true, type: true },
    });
    if (!row) return null;

    // What the batches already removed, plus whatever landed since (a
    // delivery that passed the token check before the disable committed)
    const counts = new Map(batched);
    let deletedMessages = 0;
    for (const n of counts.values()) deletedMessages += n;
    if (purge) {
      const groups = await tx.message.groupBy({
        by: ['channelId'],
        where: { webhookId },
        _count: { _all: true },
      });
      // channelId is nullable on Message, but a webhook only posts to a
      // server channel (a DM row never carries webhook_id)
      for (const g of groups) {
        if (g.channelId) counts.set(g.channelId, (counts.get(g.channelId) ?? 0) + g._count._all);
      }
      deletedMessages += (await tx.message.deleteMany({ where: { webhookId } })).count;
    }
    const perChannel = Array.from(counts, ([channelId, count]) => ({ channelId, count }));
    await tx.webhook.delete({ where: { id: webhookId } });

    return {
      webhookId,
      serverId: row.serverId,
      channelId: row.channelId,
      name: row.name,
      // Only the management router writes the column, and only WEBHOOK_TYPES values
      type: row.type as WebhookType,
      deletedMessages,
      perChannel,
    };
  }, {
    // Deleting the row makes the FK's ON DELETE SET NULL rewrite every message
    // still pointing at the webhook (each update touching every messages
    // index, the pg_trgm GIN included), and a purge deletes them. The batches
    // above leave only in-flight rows for this, but Prisma's default 5 s
    // interactive budget is still a deadline these statements never had, and
    // blowing it rolls the whole delete back (P2028, a 500). The same budget
    // as utils/accountDeletion.ts.
    timeout: 60_000,
    maxWait: 10_000,
  });
}

/** Rows per statement: large enough to finish a 100k-row history in a few
 *  dozen round trips, small enough that each statement holds its row locks
 *  for milliseconds and never blocks a reader for long. */
const HISTORY_BATCH = 5000;

/**
 * The webhook's history, in bounded single-statement batches, each its own
 * short transaction, with no lock on the webhook row: with `purge` the rows
 * are deleted (reactions cascade; the execute path never creates attachments),
 * without it `webhook_id` is set NULL as the FK's ON DELETE would, so the
 * messages keep their stored `webhook_name`. Returns what purge deleted per
 * channel, for the `message:bulk_deleted` receipts. Safe to run at any time
 * (idempotent), and the webhook is already disabled so new rows stop; the
 * locked transaction catches the few that were in flight.
 */
async function detachOrPurgeInBatches(webhookId: string, purge: boolean): Promise<Map<string, number>> {
  const perChannel = new Map<string, number>();
  for (;;) {
    if (purge) {
      const rows = (await prisma.$queryRaw<Array<{ channel_id: string | null }>>`
        DELETE FROM messages WHERE id IN (SELECT id FROM messages WHERE webhook_id = ${webhookId} LIMIT ${HISTORY_BATCH})
        RETURNING channel_id`) ?? [];
      if (rows.length === 0) break;
      for (const r of rows) {
        if (r.channel_id) perChannel.set(r.channel_id, (perChannel.get(r.channel_id) ?? 0) + 1);
      }
    } else {
      const changed = Number(await prisma.$executeRaw`
        UPDATE messages SET webhook_id = NULL WHERE id IN (SELECT id FROM messages WHERE webhook_id = ${webhookId} LIMIT ${HISTORY_BATCH})`) || 0;
      if (changed === 0) break;
    }
  }
  return perChannel;
}

/**
 * A PLATFORM ban (routes/admin.ts): the server-level kick rule one level up.
 * Every webhook whose live URL the banned account holds, in every server
 * (created by it and never rotated by another, or last rotated by it), is
 * disabled and marked `creatorRemovedAt`, so a banned abuser's URLs stop
 * posting the moment the account does; each server's owner reviews, rotates
 * or re-enables (any enable clears the mark). Rows already disabled get the
 * mark too, so a later enable is warned. Returns the servers that held one,
 * after their refetch hint went out. An unban does not re-arm them.
 */
export async function disarmWebhooksHeldBy(userId: string): Promise<string[]> {
  const held = { OR: [{ lastRotatedById: userId }, { lastRotatedAt: null, createdById: userId }] };
  const rows = await prisma.webhook.findMany({ where: held, select: { serverId: true }, distinct: ['serverId'] });
  if (rows.length === 0) return [];
  await prisma.webhook.updateMany({ where: held, data: { enabled: false, creatorRemovedAt: new Date() } });
  const serverIds = rows.map((r) => r.serverId);
  for (const serverId of serverIds) emitWebhookChanged(serverId);
  return serverIds;
}

/**
 * Announce a committed delete. With purge: one `message:bulk_deleted` receipt
 * per channel that lost rows, each to that channel's own room (the
 * VIEW_CHANNEL audience); with nothing deleted, one count-0 receipt to the
 * current channel (the client handler is idempotent and the event is the
 * purge's receipt). Then the server-wide refetch hint, always LAST.
 */
export function emitWebhookDeletion(result: WebhookDeletion, purge: boolean): void {
  if (purge) {
    const receipts = result.perChannel.length > 0
      ? result.perChannel
      : [{ channelId: result.channelId, count: 0 }];
    for (const r of receipts) {
      getIO().to(`channel:${r.channelId}`).emit(WS_EVENTS.MESSAGE_BULK_DELETED, {
        channelId: r.channelId,
        webhookId: result.webhookId,
        count: r.count,
      });
    }
  }
  emitWebhookChanged(result.serverId);
}
