import { isDeletedParticipantId } from '@voxium/shared';
import type { Conversation } from '@voxium/shared';

/**
 * A direct conversation whose other side's account was deleted: the server
 * serves it with `participantDeleted: true` and a placeholder participant whose
 * id is `deleted:{conversationId}`. Recognised by either, NEVER by a name: the
 * username `deleted` is not reserved, and a real account can be called so.
 *
 * Such a conversation is read-only: reading, marking read, deleting one's own
 * messages and removing it from the list stay; sending, editing, reacting,
 * replying, uploading, typing and calls do not, and the placeholder id never
 * leaves this client (no profile, member lookup, report, avatar or E2E
 * request names it).
 */
export function isParticipantDeleted(
  conversation: Pick<Conversation, 'participant' | 'participantDeleted'> | null | undefined,
): boolean {
  if (!conversation) return false;
  return conversation.participantDeleted === true || isDeletedParticipantId(conversation.participant?.id);
}

/** Whether the conversation `conversationId` of a loaded list is read-only; false when it is not in the list. */
export function conversationIsReadOnly(
  conversations: ReadonlyArray<Pick<Conversation, 'id' | 'participant' | 'participantDeleted'>> | null | undefined,
  conversationId: string | null | undefined,
): boolean {
  if (!conversationId || !conversations) return false;
  return isParticipantDeleted(conversations.find((c) => c.id === conversationId));
}

/**
 * Whether the DM store holds `conversationId` read-only: a loaded conversation
 * in that state, or one `dm:conversation:read_only` named before the list
 * loaded it (`readOnlyPending`). Takes the store's state as it is (a test's
 * partial state included), so it reads without importing the store.
 */
export function isHeldReadOnly(
  state: {
    conversations?: ReadonlyArray<Pick<Conversation, 'id' | 'participant' | 'participantDeleted'>> | null;
    readOnlyPending?: Readonly<Record<string, true>> | null;
  } | null | undefined,
  conversationId: string | null | undefined,
): boolean {
  if (!conversationId || !state) return false;
  return state.readOnlyPending?.[conversationId] === true || conversationIsReadOnly(state.conversations, conversationId);
}

/**
 * The English sentence of a refusal in a read-only conversation, the one the
 * server answers with too: `serverErrors.conversationReadOnly` translates
 * both (utils/serverErrors.ts).
 */
export const CONVERSATION_READ_ONLY_MESSAGE = 'This conversation is read-only';

/**
 * Refused on this client before anything is sent: an action a read-only
 * conversation does not allow (send, edit, react, reply, call).
 */
export class DMConversationReadOnlyError extends Error {
  constructor(public readonly conversationId: string) {
    super(CONVERSATION_READ_ONLY_MESSAGE);
    this.name = 'DMConversationReadOnlyError';
  }
}

/**
 * The name a conversation's other side is shown under: the localised "Deleted
 * user" for a deleted account (never the server's display name string), the
 * participant's display name otherwise.
 */
export function participantDisplayName(
  conversation: Pick<Conversation, 'participant' | 'participantDeleted'>,
  t: (key: string) => string,
): string {
  return isParticipantDeleted(conversation) ? t('dm.deletedParticipant.name') : conversation.participant.displayName;
}
