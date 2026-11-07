import type { Message } from '@voxium/shared';

/** Consecutive messages from one author within this window share one header. */
export const MESSAGE_GROUP_WINDOW_MS = 5 * 60 * 1000;

type GroupedFields = Pick<Message, 'author' | 'createdAt' | 'replyToId'>;

/**
 * Whether `curr` starts a new author group in a server channel's message
 * list (shows the avatar and the name) instead of folding under `prev`.
 *
 * Pure (no React, no store) so the rule is unit-testable without mounting
 * the virtualised list.
 *
 * A webhook author's id is not who they are: one webhook may post under a
 * different name per message, and every deleted webhook shares the single
 * id `webhook:deleted`. So for a webhook on either side, the displayed name
 * is part of the key — otherwise a second post would hide the name it was
 * posted under.
 */
export function startsMessageGroup(prev: GroupedFields | undefined, curr: GroupedFields): boolean {
  if (!prev) return true;
  if (curr.replyToId) return true;
  if (prev.author.id !== curr.author.id) return true;
  if ((prev.author.isWebhook || curr.author.isWebhook) && prev.author.displayName !== curr.author.displayName) return true;
  const timeDiff = new Date(curr.createdAt).getTime() - new Date(prev.createdAt).getTime();
  return timeDiff > MESSAGE_GROUP_WINDOW_MS;
}
