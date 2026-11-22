import { WEBHOOK_AUTHOR_ID_PREFIX } from '@voxium/shared';
import { useChatStore } from '../stores/chatStore';
import { useServerStore } from '../stores/serverStore';

/**
 * The incoming-webhook socket events, as MainLayout registers them (kept
 * here so they are unit-testable without mounting the layout — the
 * services/discoverySocketHandlers.ts precedent).
 */

/** The `message:bulk_deleted` payload (ServerToClientEvents in @voxium/shared). */
export interface MessageBulkDeletedPayload {
  channelId: string;
  webhookId: string;
  count: number;
}

/** The `webhook:messages_detached` payload (ServerToClientEvents in @voxium/shared). */
export interface WebhookMessagesDetachedPayload {
  channelId: string;
  webhookId: string;
}

/**
 * How long a webhook purged on the server is remembered, so a `message:new`
 * of a delivery that committed just before the purge and reached this client
 * after its receipt is dropped (with more than one node the two events can
 * arrive in either order). The late event follows its receipt by moments; a
 * webhook id is never reused, so the bound only caps memory.
 */
export const PURGED_WEBHOOK_MEMORY_MS = 60_000;
export const PURGED_WEBHOOK_MAX = 200;
/** A purge emits one receipt per channel: the unread counts are asked once for the burst. */
export const UNREAD_REFRESH_DEBOUNCE_MS = 1_000;

/**
 * webhookId -> when it stops being remembered, oldest first, with the kind of
 * delete that was announced: a purged webhook's late delivery is dropped, a
 * detached (deleted without purge) one's is shown with the deleted-webhook
 * label, as the server serves it at the next fetch.
 */
type WebhookEnd = 'purged' | 'detached';
const endedWebhooks = new Map<string, { until: number; kind: WebhookEnd }>();
const pendingUnreadChannels = new Set<string>();
let unreadRefreshTimer: ReturnType<typeof setTimeout> | null = null;

/** Forgets everything this module holds: the logout of the account it belongs to. */
export function resetWebhookSocketState(): void {
  endedWebhooks.clear();
  pendingUnreadChannels.clear();
  if (unreadRefreshTimer) { clearTimeout(unreadRefreshTimer); unreadRefreshTimer = null; }
}

function rememberEndedWebhook(webhookId: string, kind: WebhookEnd): void {
  const now = Date.now();
  endedWebhooks.delete(webhookId);
  endedWebhooks.set(webhookId, { until: now + PURGED_WEBHOOK_MEMORY_MS, kind });
  for (const [id, entry] of endedWebhooks) {
    if (entry.until > now && endedWebhooks.size <= PURGED_WEBHOOK_MAX) break;
    endedWebhooks.delete(id);
  }
}

function endedKindOf(webhookId: unknown): WebhookEnd | null {
  if (typeof webhookId !== 'string' || webhookId === '') return null;
  const entry = endedWebhooks.get(webhookId);
  if (!entry) return null;
  if (entry.until <= Date.now()) { endedWebhooks.delete(webhookId); return null; }
  return entry.kind;
}

/**
 * Whether a live `message:new` was posted by a webhook this client has just
 * been told was purged: such a row no longer exists on the server and must
 * neither be shown nor counted nor sounded. Reads `webhookId` only; a human's
 * row never carries one.
 */
export function isPurgedWebhookMessage(message: { webhookId?: string | null } | null | undefined): boolean {
  return endedKindOf(message?.webhookId) === 'purged';
}

/**
 * A live `message:new` from a webhook this client was just told was deleted
 * WITHOUT purge (`webhook:messages_detached`): the row is real and is shown,
 * counted and sounded as usual, but the server now serves it as a deleted
 * webhook's, so it gets that shape here (webhookId null, author id
 * `webhook:deleted`, name kept). Any other message is returned as it is.
 */
export function withDetachedWebhookLabel<M extends { webhookId?: string | null; author: { id: string } }>(message: M): M {
  if (endedKindOf(message.webhookId) !== 'detached') return message;
  return { ...message, webhookId: null, author: { ...message.author, id: WEBHOOK_AUTHOR_ID_PREFIX + 'deleted' } };
}

function scheduleUnreadRefresh(channelId: string): void {
  pendingUnreadChannels.add(channelId);
  if (unreadRefreshTimer) return;
  unreadRefreshTimer = setTimeout(() => {
    unreadRefreshTimer = null;
    const channelIds = Array.from(pendingUnreadChannels);
    pendingUnreadChannels.clear();
    void useServerStore.getState().refreshChannelUnread(channelIds).catch((err: unknown) => {
      console.warn('[Webhooks] The unread refresh after a purge failed:', err instanceof Error ? err.message : err);
    });
  }, UNREAD_REFRESH_DEBOUNCE_MS);
}

/** The two ids the handler acts on. `count` is informational (nothing here
 *  reads it), so a payload is not refused over it. */
function isBulkDeletedPayload(v: unknown): v is Pick<MessageBulkDeletedPayload, 'channelId' | 'webhookId'> {
  if (!v || typeof v !== 'object') return false;
  const p = v as Partial<Record<keyof MessageBulkDeletedPayload, unknown>>;
  return typeof p.channelId === 'string' && p.channelId.length > 0
    && typeof p.webhookId === 'string' && p.webhookId.length > 0;
}

/**
 * `message:bulk_deleted` → a moderator deleted a webhook with purge: drop
 * the loaded rows it posted in that channel.
 *
 * It reaches `channel:{id}`, and the socket sits in every channel room the
 * user can view, while chatStore holds ONE channel's (or one DM's) rows —
 * so it acts only when that channel is the one on screen (`isViewingChannel`
 * is MainLayout's: the channel id AND the server view).
 *
 * The event says how many rows went, not how many of them this user had not
 * read, so the unread count of the channel (on screen or not: the socket sits
 * in every channel room it can view) is asked of the server instead, once per
 * burst (a purge emits one receipt per channel), after the debounce. The
 * webhook is also remembered for a short while: a delivery that committed
 * just before the purge may still announce itself (`isPurgedWebhookMessage`).
 */
export function handleMessageBulkDeleted(
  data: unknown,
  isViewingChannel: (channelId: string | null | undefined) => boolean,
): void {
  // Socket payloads are untyped JSON at runtime (TypeScript is erased)
  if (!isBulkDeletedPayload(data)) {
    console.warn('[Webhooks] Ignoring a malformed message:bulk_deleted payload');
    return;
  }
  rememberEndedWebhook(data.webhookId, 'purged');
  scheduleUnreadRefresh(data.channelId);
  if (!isViewingChannel(data.channelId)) return;
  const loadedBefore = useChatStore.getState().messages.length;
  useChatStore.getState().removeWebhookMessages(data.channelId, data.webhookId);

  // A purge that empties the loaded window while more history exists (older
  // pages, or newer ones in a jumped-to window) would leave a blank channel
  // for good: MessageList renders no Virtuoso for an empty list, and its
  // handleStartReached bails on length 0, so nothing could page the rest in.
  // Reload the channel's latest page the way ChatArea does.
  const after = useChatStore.getState();
  if (loadedBefore > 0 && after.messages.length === 0 && (after.hasMore || after.hasMoreAfter)) {
    void after.fetchMessages(data.channelId);
  }
}

/**
 * `webhook:messages_detached` -> a webhook was deleted WITHOUT purge: its rows
 * in that channel stay and the server now shapes them as a deleted webhook's.
 * The loaded ones are re-labelled in place (no refetch) when the chat view is
 * of that channel; chatStore drops it for another scope or none recorded.
 * Reaches `channel:{id}` only (never the space room).
 */
export function handleWebhookMessagesDetached(data: unknown): void {
  if (!isDetachedPayload(data)) {
    console.warn('[Webhooks] Ignoring a malformed webhook:messages_detached payload');
    return;
  }
  rememberEndedWebhook(data.webhookId, 'detached');
  useChatStore.getState().markWebhookDeleted(data.channelId, data.webhookId);
}

function isDetachedPayload(v: unknown): v is WebhookMessagesDetachedPayload {
  return isBulkDeletedPayload(v);
}
