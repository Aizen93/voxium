import { useChatStore } from '../stores/chatStore';

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
 * Unread counters are NOT adjusted: the event says how many rows went, not
 * how many of them this user had not read. They reconcile on the next fetch
 * (unread:init / the channel's next read).
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
