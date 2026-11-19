import { DELETED_PARTICIPANT_ID_PREFIX } from '@voxium/shared';

/**
 * The placeholder that stands for a deleted account in a direct conversation.
 *
 * `conversations.user1_id` / `user2_id` are nullable (migration
 * 20261116120000_conversation_lifecycle_expand) so that a conversation can
 * outlive one participant, and a message row there can lose its author. The
 * wire keeps a non-null `participant` and `author` for every client, a 2.1.x
 * desktop included (it reads `participant.avatarUrl` unguarded), so the
 * server builds this placeholder wherever such a side or author would be
 * sent.
 *
 * The id is `deleted:{conversationId}`: built from the conversation, never
 * from the deleted account, so it names nobody and differs per conversation.
 * The colon means it can never EQUAL a user id (a cuid holds no colon), and it
 * fails OPAQUE_ID_RE (@voxium/shared), like the webhook author ids, so the
 * routes that apply that check (the member lookups) refuse it. A route that
 * takes the raw id to the database simply finds no such user.
 *
 * The other fields are the neutral values of the selects the DM routes use:
 * no avatar, offline, no staff or supporter badge. A quote's author is
 * selected without presence, so its placeholder (deletedQuoteAuthor) carries
 * no `status` either: for the row and quote selects of routes/dm.ts, a
 * placeholder has exactly the keys of the live author it stands in for. The
 * call notice of websocket/dmVoiceHandler.ts selects four keys and would get
 * the eight-key placeholder, which cannot happen today: a notice is written
 * with its caller as author.
 */

export const DELETED_PARTICIPANT_USERNAME = 'deleted';
export const DELETED_PARTICIPANT_DISPLAY_NAME = 'Deleted user';

/**
 * The placeholder's username is reserved for new accounts, in any case
 * (registration answers it exactly like a name already in use, so the
 * reservation is no oracle; services/signupService.ts). An account that held
 * the name before it was reserved keeps it: no client may tell the
 * placeholder by its name, only by `participantDeleted` or the id prefix.
 */
export function isReservedUsername(username: string): boolean {
  return username.toLowerCase() === DELETED_PARTICIPANT_USERNAME;
}

export interface DeletedParticipant {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: null;
  status: 'offline';
  role: 'user';
  isSupporter: false;
  supporterTier: null;
}

export function deletedParticipantId(conversationId: string): string {
  return DELETED_PARTICIPANT_ID_PREFIX + conversationId;
}

/** The placeholder as a quote's author: the participant's keys without `status`. */
export type DeletedQuoteAuthor = Omit<DeletedParticipant, 'status'>;

/** A fresh placeholder each call: callers may spread or extend it. */
export function deletedParticipant(conversationId: string): DeletedParticipant {
  return {
    id: deletedParticipantId(conversationId),
    username: DELETED_PARTICIPANT_USERNAME,
    displayName: DELETED_PARTICIPANT_DISPLAY_NAME,
    avatarUrl: null,
    status: 'offline',
    role: 'user',
    isSupporter: false,
    supporterTier: null,
  };
}

/** The placeholder for the author of a quote (dm.ts `replyToSelect`: no status); a fresh object each call. */
export function deletedQuoteAuthor(conversationId: string): DeletedQuoteAuthor {
  const { status: _status, ...author } = deletedParticipant(conversationId);
  return author;
}

/** A conversation row with both sides' accounts loaded (NULL where a side's account is gone). */
export interface ConversationSides<U extends object> {
  id: string;
  user1Id: string | null;
  user2Id: string | null;
  user1: U | null;
  user2: U | null;
}

export type OtherParticipant<U extends object> =
  | { participant: U; participantDeleted?: never }
  | { participant: DeletedParticipant; participantDeleted: true };

/**
 * The side of a conversation the viewer talks to. When that side's account is
 * gone, the placeholder and `participantDeleted: true`; otherwise the account
 * as loaded and NO `participantDeleted` key at all, so a live conversation
 * serialises exactly as it did before the sides became nullable.
 */
export function otherParticipant<U extends object>(
  conversation: ConversationSides<U>,
  viewerId: string,
): OtherParticipant<U> {
  const other = conversation.user1Id === viewerId ? conversation.user2 : conversation.user1;
  if (other !== null) return { participant: other };
  return { participant: deletedParticipant(conversation.id), participantDeleted: true };
}
