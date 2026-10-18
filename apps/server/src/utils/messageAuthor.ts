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
 * is deliberate: it can never pass the server's opaque-id check
 * (`/^[A-Za-z0-9_-]{1,64}$/`, routes/servers.ts), so it can never be mistaken
 * for — or looked up as — a user id.
 */

export const WEBHOOK_AUTHOR_ID_PREFIX = 'webhook:';
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
}

export interface WebhookMessageAuthor {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: null;
  isWebhook: true;
}

export type ShapedAuthor<R extends MessageAuthorSource> = NonNullable<R['author']> | WebhookMessageAuthor;

/** The columns that tell a webhook row apart, as loosely as callers select them. */
export interface WebhookRowMarkers {
  webhookId?: string | null;
  webhookName?: string | null;
  authorId?: string | null;
}

/**
 * Whether a row was posted by an incoming webhook — while the webhook exists
 * AND after it is deleted. `webhookId` alone is not enough: deleting the
 * webhook SETs it NULL, but the row keeps its frozen `webhookName` and its
 * NULL `authorId` (webhook rows are the only authorless rows; deleting a user
 * cascades their messages). An absent field (not selected) never counts.
 */
export function isWebhookRow(row: WebhookRowMarkers): boolean {
  return (row.webhookId !== null && row.webhookId !== undefined)
    || (row.webhookName !== null && row.webhookName !== undefined)
    || row.authorId === null;
}

/**
 * A human author passes through unchanged (whatever subset of fields the caller
 * selected); a null one — a webhook row — becomes the synthesised author.
 */
export function shapeMessageAuthor<R extends MessageAuthorSource>(row: R): ShapedAuthor<R> {
  if (row.author !== null) return row.author as NonNullable<R['author']>;
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

type ShapedReply<P> = P extends MessageAuthorSource ? Omit<P, 'author'> & { author: ShapedAuthor<P> } : P;

export type ShapedMessageRow<R extends MessageAuthorSource> =
  Omit<R, 'author' | 'replyTo'> &
  { author: ShapedAuthor<R> } &
  ('replyTo' extends keyof R ? { replyTo: ShapedReply<R['replyTo' & keyof R]> } : unknown);

/**
 * `shapeMessageAuthor` applied to a row's `author` and, when the row carries a
 * `replyTo` quote, to the quote's author too. Everything else is returned as is.
 */
export function shapeMessageRow<
  R extends MessageAuthorSource & { replyTo?: MessageAuthorSource | null },
>(row: R): ShapedMessageRow<R> {
  const shaped: Record<string, unknown> = { ...(row as object), author: shapeMessageAuthor(row) };
  if (row.replyTo) {
    shaped.replyTo = { ...row.replyTo, author: shapeMessageAuthor(row.replyTo) };
  }
  return shaped as ShapedMessageRow<R>;
}
