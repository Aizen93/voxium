import { MENTION_RE, LIMITS } from '@voxium/shared';
import { prisma } from './prisma';
import { isWebhookRow, type WebhookRowMarkers } from './messageAuthor';

/** Extract unique user IDs from @[userId] tokens in message content. Capped to MAX_MENTIONS_PER_MESSAGE. */
export function extractMentionIds(content: string): string[] {
  const ids = new Set<string>();
  // Reset lastIndex since MENTION_RE is global
  const re = new RegExp(MENTION_RE.source, MENTION_RE.flags);
  let match;
  while ((match = re.exec(content)) !== null) {
    ids.add(match[1]);
    if (ids.size >= LIMITS.MAX_MENTIONS_PER_MESSAGE) break;
  }
  return Array.from(ids);
}

const mentionUserSelect = {
  id: true, username: true, displayName: true, avatarUrl: true,
} as const;

/**
 * Resolve mention user IDs to user profiles, filtered to server members.
 * Returns only users that are actually members of the given server.
 */
export async function resolveMentionsForServer(
  mentionIds: string[],
  serverId: string,
): Promise<Array<{ id: string; username: string; displayName: string; avatarUrl: string | null }>> {
  if (mentionIds.length === 0) return [];
  const members = await prisma.serverMember.findMany({
    where: { serverId, userId: { in: mentionIds } },
    select: { user: { select: mentionUserSelect } },
  });
  return members.map((m) => m.user);
}

/**
 * The row fields mention resolution looks at. A row is never mention-parsed
 * when it is ciphertext (`encrypted`) or webhook-posted (isWebhookRow: a
 * webhookId, a frozen webhookName — which outlives the webhook — or a NULL
 * authorId): an unauthenticated webhook URL must never ping anyone, and a
 * refetch must agree with the live event, which carries no mentions for it.
 */
export interface MentionSourceRow extends WebhookRowMarkers {
  content: string;
  encrypted?: boolean;
}

function skipsMentions(row: MentionSourceRow): boolean {
  return Boolean(row.encrypted) || isWebhookRow(row);
}

/**
 * Batch-resolve mentions across multiple messages.
 * Returns a Map of userId -> user profile for efficient per-message lookup.
 */
export async function batchResolveMentions(
  messages: MentionSourceRow[],
  serverId: string,
): Promise<Map<string, { id: string; username: string; displayName: string; avatarUrl: string | null }>> {
  const allIds = new Set<string>();
  for (const m of messages) {
    if (skipsMentions(m)) continue; // ciphertext and webhook rows are never mention-parsed
    for (const id of extractMentionIds(m.content)) {
      allIds.add(id);
    }
  }
  if (allIds.size === 0) return new Map();

  const members = await prisma.serverMember.findMany({
    where: { serverId, userId: { in: [...allIds] } },
    select: { user: { select: mentionUserSelect } },
  });

  const map = new Map<string, typeof members[0]['user']>();
  for (const m of members) {
    map.set(m.user.id, m.user);
  }
  return map;
}

/** Attach resolved mentions to a single message based on its content. */
export function attachMentions(
  message: MentionSourceRow,
  mentionMap: Map<string, { id: string; username: string; displayName: string; avatarUrl: string | null }>,
) {
  if (skipsMentions(message)) return [];
  const ids = extractMentionIds(message.content);
  return ids.map((id) => mentionMap.get(id)).filter(Boolean);
}
