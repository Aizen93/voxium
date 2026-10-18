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
  createdAt: true,
  lastUsedAt: true,
  createdBy: { select: { id: true, username: true, displayName: true } },
} as const;

export interface WebhookRow {
  id: string;
  serverId: string;
  channelId: string;
  name: string;
  type: string;
  enabled: boolean;
  createdAt: Date;
  lastUsedAt: Date | null;
  createdBy: { id: string; username: string; displayName: string } | null;
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
    createdBy: row.createdBy
      ? { id: row.createdBy.id, username: row.createdBy.username, displayName: row.createdBy.displayName }
      : null,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
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
 */
export async function deleteWebhookWithPurge(webhookId: string, purge: boolean): Promise<WebhookDeletion | null> {
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

    let perChannel: Array<{ channelId: string; count: number }> = [];
    let deletedMessages = 0;
    if (purge) {
      const groups = await tx.message.groupBy({
        by: ['channelId'],
        where: { webhookId },
        _count: { _all: true },
      });
      // channelId is nullable on Message, but a webhook only posts to a
      // server channel (a DM row never carries webhook_id)
      perChannel = groups.flatMap((g) => (g.channelId ? [{ channelId: g.channelId, count: g._count._all }] : []));
      deletedMessages = (await tx.message.deleteMany({ where: { webhookId } })).count;
    }
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
  });
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
