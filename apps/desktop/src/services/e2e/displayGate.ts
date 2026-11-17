// The display gate's shared vocabulary — used by dmCrypto (DMs), channelCrypto
// (secure channels) and chatStore (the sender's own row). Pure functions over a
// Message: no store, service or crypto import, so any module may use them.
//
// The gate's rule: nothing the crypto did not vouch for reaches a store or the
// DOM. The server's word on a row (its `encrypted` flag, its `type`, a quote,
// a file, a mention) is dropped or locked; what remains is either the
// decrypted message or the "unable to decrypt" marker, or in a DM the row the
// gate builds for a deleted account's message (deletedMessageRow), which holds
// nothing but the server's id, conversation and time.
import { parseE2EPlaintext, isDMSystemNotice, DELETED_MESSAGE_TYPE, DELETED_PARTICIPANT_ID_PREFIX, isDeletedParticipantId } from '@voxium/shared';
import type { Message, MessageAuthor, E2EAttachmentMeta } from '@voxium/shared';

/** Content of a row that could not be shown; with `encrypted: true` the UI renders its "unable to decrypt" marker. */
export const DECRYPT_FAILED_CONTENT = '';

/**
 * The row for plaintext the crypto vouched for: text and attachments come out
 * of the decrypted payload. The type is pinned to `user` — a notice is never
 * encrypted, so a `system` type on an encrypted row is the server trying to
 * show authentic words as a server notice (no author, no bubble).
 */
export function decryptedRow(message: Message, raw: string): Message {
  const { text, attachments } = parseE2EPlaintext(raw);
  // The callers strip first already; stripping here too keeps the shape safe
  // for any caller that hands in the server's row as it came off the wire
  return { ...withoutServerAssertions(message), type: 'user', content: text, ...(attachments.length > 0 && { e2eAttachments: attachments }) };
}

/** A quote whose text nothing vouched for: the lock placeholder. */
export function lockedQuote(quote: NonNullable<Message['replyTo']>): NonNullable<Message['replyTo']> {
  return { ...quote, content: '', encrypted: true };
}

/**
 * What the server asserts about an encrypted message that the crypto never
 * vouched for, dropped before anything else looks at the row:
 *  - `e2eAttachments` is a CLIENT field that comes out of the decrypted payload
 *    and nowhere else; one on the wire is the server choosing a file (blob, key
 *    and IV) to render inside a contact's authenticated message;
 *  - `mentions` names the people an `@[id]` in the text resolves to — the
 *    server never resolves mentions for encrypted rows, so a list on one is the
 *    server renaming an authentic mention (and setting off a "mentioned you");
 *  - `author.isWebhook`, `webhookId` and `webhookName` say an incoming webhook
 *    posted the row — but a webhook never posts an encrypted row, nor into a
 *    DM, so on one of these rows it is the server relabelling an authentic
 *    message as an app: an APP tag, no profile, no Report on a DM (which must
 *    stay reportable), no Edit on the user's own message;
 *  - `mentionsEveryone` is the server's word that the author held
 *    MENTION_EVERYONE and wrote `@everyone` — it never reads ciphertext, so on
 *    an encrypted row it is the server deciding that an authentic message
 *    pings everyone (a badge, the mention sound, a "mentioned everyone" title).
 */
export function withoutServerAssertions(message: Message): Message {
  const author = message.author as MessageAuthor | undefined;
  const authorClaimsWebhook = author !== undefined && author !== null && 'isWebhook' in author;
  const rowClaimsWebhook = 'webhookId' in message || 'webhookName' in message;
  const rowClaimsPing = 'mentionsEveryone' in message;
  if (message.e2eAttachments === undefined && !message.mentions?.length && !authorClaimsWebhook && !rowClaimsWebhook && !rowClaimsPing) {
    return message;
  }
  const rest: Message = { ...message, mentions: [] };
  delete rest.e2eAttachments;
  delete rest.webhookId;
  delete rest.webhookName;
  delete rest.mentionsEveryone;
  if (authorClaimsWebhook) {
    const human: MessageAuthor = { ...author };
    delete human.isWebhook;
    rest.author = human;
  }
  return rest;
}

/**
 * A row the gate refuses: no text, no server-asserted attachments, no quoted
 * text, and flagged so the UI renders its "unable to decrypt" marker — an
 * empty bubble under a contact's name, with a file the server chose, is the
 * forgery the refusal exists to stop. Every failure path of the gate returns
 * this shape (a decrypt failure still resolves the quote from the local cache).
 */
export function refusedRow(message: Message): Message {
  return {
    ...withoutServerAssertions(message),
    // a refused "system" row must not render as a (blank) call notice
    type: 'user',
    content: DECRYPT_FAILED_CONTENT,
    encrypted: true,
    attachments: [],
    replyTo: message.replyTo ? lockedQuote(message.replyTo) : message.replyTo,
  };
}

/**
 * Whether a row shows the "unable to decrypt" marker (MessageItem renders it
 * for an encrypted row with no text and no file from the payload): the shape
 * every failure path of the gate returns.
 */
export function isRefusedShape(message: Message): boolean {
  return message.encrypted === true && !message.content && !message.e2eAttachments?.length;
}

/**
 * The author a direct conversation shows where the other person's account was
 * deleted: built HERE from the conversation id (`deleted:{conversationId}`,
 * the id the server uses too), never from what a row carries. Its id is never
 * a user id (the colon) and names nobody; the UI renders the localised "Deleted
 * user" for it and never this object's strings.
 */
export function deletedParticipantAuthor(conversationId: string): MessageAuthor {
  return {
    id: DELETED_PARTICIPANT_ID_PREFIX + conversationId,
    username: 'deleted',
    displayName: 'Deleted user',
    avatarUrl: null,
    role: 'user',
    isSupporter: false,
    supporterTier: null,
  };
}

/**
 * The row that stands for a deleted account's message in a DM
 * (`type: DELETED_MESSAGE_TYPE`). Every field is set here: the server's id,
 * conversation and time, and nothing else it sent — no text, no ciphertext,
 * no file, no reaction, no quote, no mention, no webhook or ping claim, its
 * author the placeholder above. A server that puts words in such a row shows
 * the user nothing but "Message deleted". DM scope only: the channel gates
 * never build it.
 */
export function deletedMessageRow(message: Message, conversationId: string): Message {
  return {
    id: message.id,
    type: DELETED_MESSAGE_TYPE,
    content: '',
    encrypted: false,
    channelId: null,
    conversationId,
    replyToId: null,
    replyTo: null,
    author: deletedParticipantAuthor(conversationId),
    mentions: [],
    attachments: [],
    reactions: [],
    createdAt: typeof message.createdAt === 'string' ? message.createdAt : '',
    editedAt: null,
  };
}

/** Whether a DM row is the gate's deleted-message row (deletedMessageRow). */
export function isDeletedMessageRow(message: Pick<Message, 'type'>): boolean {
  return message.type === DELETED_MESSAGE_TYPE;
}

/**
 * Whether a DM quote stands for a deleted account's message: its author is
 * the placeholder and it is not one of that account's call notices (which
 * keep their fixed text). A quote carries no `type`, so the author is what
 * says it; the UI shows "Message deleted" for it, never the quote's text.
 */
export function isDeletedQuote(quote: NonNullable<Message['replyTo']>): boolean {
  if (!isDeletedParticipantId(quote.author?.id)) return false;
  return quote.encrypted === true || !isDMSystemNotice(quote.content);
}

/** A deleted account's quote as the gate keeps it: the id and the placeholder author, no text. */
export function deletedQuote(quote: NonNullable<Message['replyTo']>, conversationId: string): NonNullable<Message['replyTo']> {
  return { id: quote.id, content: '', encrypted: false, author: deletedParticipantAuthor(conversationId) };
}

/**
 * The quote on a message THIS client just sent, from the message it was
 * replying to — already through the gate when it was displayed — never from
 * the server's reply to the POST.
 */
export function ownReplyQuote(replyingTo: Message | null): Message['replyTo'] {
  if (!replyingTo) return null;
  return { id: replyingTo.id, author: replyingTo.author, content: replyingTo.content, encrypted: replyingTo.encrypted };
}

/**
 * The sender's own row: the server's id and timestamps, and otherwise what
 * this client knows — the text it typed, the files it attached, the message
 * it replied to, and that it was an encrypted user message with no plaintext
 * attachment. Whichever of the POST reply and the gated socket echo lands
 * first owns the id (the store's id dedupe drops the other), so this row must
 * not carry anything the server put in the reply: a quote under a contact's
 * name, a file of its choosing, a renamed mention, a dropped lock.
 */
export function ownSentRow(
  raw: Message,
  local: { content: string; replyingTo: Message | null; e2eAttachments?: E2EAttachmentMeta[] },
): Message {
  return {
    ...withoutServerAssertions(raw),
    type: 'user',
    encrypted: true,
    attachments: [],
    content: local.content,
    replyTo: ownReplyQuote(local.replyingTo),
    ...(local.e2eAttachments?.length && { e2eAttachments: local.e2eAttachments }),
  };
}
