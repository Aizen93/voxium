import type { TFunction } from 'i18next';
import type { MessageAuthor } from '@voxium/shared';

/**
 * The author name a desktop notification shows for a server message.
 *
 * A webhook picks its own name on every post (`username` in the payload), so
 * whoever holds its URL can post as "alice". In the channel the APP tag next
 * to the name tells the two apart; a notification has no tag, so the marker
 * travels inside the text: "alice · APP". A human author's name is unchanged.
 */
export function notificationAuthorName(
  author: Pick<MessageAuthor, 'displayName' | 'username' | 'isWebhook'> | null | undefined,
  t: TFunction,
): string {
  const name = author?.displayName || author?.username || 'Someone';
  return author?.isWebhook === true ? `${name} · ${t('messageItem.appTag')}` : name;
}
