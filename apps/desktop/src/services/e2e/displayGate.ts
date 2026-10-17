// The display gate's shared vocabulary — used by dmCrypto (DMs), channelCrypto
// (secure channels) and chatStore (the sender's own row). Pure functions over a
// Message: no store, service or crypto import, so any module may use them.
//
// The gate's rule: nothing the crypto did not vouch for reaches a store or the
// DOM. The server's word on a row (its `encrypted` flag, its `type`, a quote,
// a file, a mention) is dropped or locked; what remains is either the
// decrypted message or the "unable to decrypt" marker.
import { parseE2EPlaintext } from '@voxium/shared';
import type { Message, E2EAttachmentMeta } from '@voxium/shared';

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
  return { ...message, type: 'user', content: text, ...(attachments.length > 0 && { e2eAttachments: attachments }) };
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
 *    server renaming an authentic mention (and setting off a "mentioned you").
 */
export function withoutServerAssertions(message: Message): Message {
  if (message.e2eAttachments === undefined && !message.mentions?.length) return message;
  const rest: Message = { ...message, mentions: [] };
  delete rest.e2eAttachments;
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
