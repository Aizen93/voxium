import { WEBHOOK_AUTHOR_ID_PREFIX } from '@voxium/shared';
import {
  deletedParticipant,
  deletedQuoteAuthor,
  type DeletedParticipant,
  type DeletedQuoteAuthor,
} from './deletedParticipant';

/**
 * The one place a Message row's author is shaped for the wire.
 *
 * `Message.authorId` is nullable since incoming webhooks: a webhook-posted row
 * has no user author, only `webhookId` (SET NULL once the webhook is deleted)
 * and `webhookName` (the label frozen at post time). The shared `Message` type
 * keeps a NON-null `author`, so every server reader passes its rows through
 * here and a webhook row gets a synthesised author instead of `null`.
 *
 * The synthesised id is `webhook:{webhookId}` (or `webhook:deleted`). The colon
 * is deliberate: it can never pass the opaque-id check (`OPAQUE_ID_RE`,
 * @voxium/shared, applied by routes/servers.ts), and it can never EQUAL a user
 * id (a cuid holds no colon).
 *
 * Webhooks post in channels only. Inside a conversation a NULL author is a
 * deleted account's message (the account deletion that keeps a conversation
 * for the other person writes it, utils/conversationLifecycle.ts): such a
 * row gets the deleted-account placeholder
 * (`deleted:{conversationId}`, utils/deletedParticipant.ts), never a webhook
 * label. A DM reader shapes its rows with shapeConversationMessageRow() /
 * shapeConversationMessageAuthor(), which take the conversation as a REQUIRED
 * argument, so a select that leaves `conversationId` out cannot mislabel the
 * row. The generic shapers (channels, search, the webhook execute route) read
 * the conversation from the row only: a row without one is judged as before.
 */

// From @voxium/shared: the desktop matches reply quotes on the same prefix
export { WEBHOOK_AUTHOR_ID_PREFIX };
/** Only reached if a row breaks the write invariant (webhook row without a name). */
export const WEBHOOK_AUTHOR_FALLBACK_NAME = 'Webhook';

/**
 * What a reader must select for the author to be shaped. `webhookId` and
 * `webhookName` are REQUIRED on purpose: a `select` (a `replyTo` quote, say)
 * that forgets them fails to typecheck instead of shipping a webhook quote
 * under the fallback label.
 */
export interface MessageAuthorSource<A extends object = object> {
  author: A | null;
  webhookId: string | null;
  webhookName: string | null;
  /** Read by the generic shapers only; absent (not selected) reads as no conversation. */
  conversationId?: string | null;
}

export interface WebhookMessageAuthor {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: null;
  isWebhook: true;
}

export type ShapedAuthor<R extends MessageAuthorSource> = NonNullable<R['author']> | WebhookMessageAuthor | DeletedParticipant;
/** A quote's author: a quote select carries no presence, so neither does its placeholder. */
export type ShapedQuoteAuthor<R extends MessageAuthorSource> = NonNullable<R['author']> | WebhookMessageAuthor | DeletedQuoteAuthor;

/** The columns that tell a webhook row apart, as loosely as callers select them. */
export interface WebhookRowMarkers {
  webhookId?: string | null;
  webhookName?: string | null;
  authorId?: string | null;
  conversationId?: string | null;
}

function present(value: string | null | undefined): value is string {
  return value !== null && value !== undefined;
}

/**
 * THE rule for a row without an author: it is a deleted account's message
 * when it belongs to a conversation and no webhook column marks it. Every
 * other authorless row is a webhook's. isWebhookRow() and the shapers below
 * all decide through this one predicate.
 */
function isDeletedAccountMessage(
  row: { webhookId?: string | null; webhookName?: string | null },
  conversationId: string | null | undefined,
): conversationId is string {
  return !present(row.webhookId) && !present(row.webhookName)
    && present(conversationId) && conversationId !== '';
}

/**
 * Whether a row was posted by an incoming webhook — while the webhook exists
 * AND after it is deleted. `webhookId` alone is not enough: deleting the
 * webhook SETs it NULL, but the row keeps its frozen `webhookName` and its
 * NULL `authorId`. A NULL `authorId` counts unless the row is a deleted
 * account's message (isDeletedAccountMessage). An absent field (not selected)
 * never counts, so a row read without `conversationId` is judged as before.
 */
export function isWebhookRow(row: WebhookRowMarkers): boolean {
  if (row.authorId === null) return !isDeletedAccountMessage(row, row.conversationId);
  return present(row.webhookId) || present(row.webhookName);
}

/** A human author as is; a null one as the placeholder in a conversation, as the webhook's otherwise. */
function shapeAuthorWith<R extends MessageAuthorSource, P>(
  row: R,
  conversationId: string | null | undefined,
  placeholder: (conversationId: string) => P,
): NonNullable<R['author']> | WebhookMessageAuthor | P {
  if (row.author !== null) return row.author as NonNullable<R['author']>;
  if (isDeletedAccountMessage(row, conversationId)) return placeholder(conversationId);
  let name = row.webhookName;
  if (!name) {
    console.warn('[messageAuthor] Message row without an author or a webhook name; using the fallback label', {
      messageId: (row as { id?: unknown }).id,
    });
    name = WEBHOOK_AUTHOR_FALLBACK_NAME;
  }
  return {
    id: WEBHOOK_AUTHOR_ID_PREFIX + (row.webhookId ?? 'deleted'),
    username: name,
    displayName: name,
    avatarUrl: null,
    isWebhook: true,
  };
}

type ShapedReply<P> = P extends MessageAuthorSource ? Omit<P, 'author'> & { author: ShapedQuoteAuthor<P> } : P;

export type ShapedMessageRow<R extends MessageAuthorSource> =
  Omit<R, 'author' | 'replyTo'> &
  { author: ShapedAuthor<R> } &
  ('replyTo' extends keyof R ? { replyTo: ShapedReply<R['replyTo' & keyof R]> } : unknown);

type ShapeableRow = MessageAuthorSource & { replyTo?: MessageAuthorSource | null };

function shapeRow<R extends ShapeableRow>(row: R, conversationId: string | null | undefined): ShapedMessageRow<R> {
  const shaped: Record<string, unknown> = { ...(row as object), author: shapeAuthorWith(row, conversationId, deletedParticipant) };
  if (row.replyTo) {
    // a quote is in the quoting row's conversation (its select carries none)
    shaped.replyTo = { ...row.replyTo, author: shapeAuthorWith(row.replyTo, conversationId, deletedQuoteAuthor) };
  }
  return shaped as ShapedMessageRow<R>;
}

/**
 * A channel-side row's author (search, the call sites outside a
 * conversation): the conversation, if any, from the row itself.
 */
export function shapeMessageAuthor<R extends MessageAuthorSource>(row: R): ShapedAuthor<R> {
  return shapeAuthorWith(row, row.conversationId, deletedParticipant);
}

/**
 * The author of a row of the conversation `conversationId` (required: the
 * caller knows which conversation it reads, whatever its select carries).
 */
export function shapeConversationMessageAuthor<R extends MessageAuthorSource>(row: R, conversationId: string): ShapedAuthor<R> {
  return shapeAuthorWith(row, conversationId, deletedParticipant);
}

/**
 * The generic shaper (channels, the webhook execute route): the row's
 * `author` and, when it carries a `replyTo` quote, the quote's author, with
 * the conversation the row itself carries. Everything else is returned as is.
 */
export function shapeMessageRow<R extends ShapeableRow>(row: R): ShapedMessageRow<R> {
  return shapeRow(row, row.conversationId);
}

/**
 * shapeMessageRow() for a row of the conversation `conversationId`, given by
 * the caller (required): every DM reader shapes through this one.
 */
export function shapeConversationMessageRow<R extends ShapeableRow>(row: R, conversationId: string): ShapedMessageRow<R> {
  return shapeRow(row, conversationId);
}
