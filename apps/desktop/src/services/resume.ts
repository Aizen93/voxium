import { useServerStore } from '../stores/serverStore';
import { useDMStore } from '../stores/dmStore';
import { getSocket, ensureSocketConnected } from './socket';

/**
 * What the app does when its window comes back: restored from the taskbar or
 * the tray, the tab shown again, the network back after a sleep.
 *
 * While the window was away the browser throttled every timer, the socket may
 * have dropped and its manager may have spent its attempts, the access token
 * may have expired (it lives 15 minutes), and every event sent meanwhile is
 * gone. Two cases:
 *
 * - The socket is NOT connected: reconnecting is the whole refresh. The
 *   connect handlers (MainLayout, the chat areas, voiceStore) refetch the
 *   servers, the People slice, the DM list, the friends, the open channel or
 *   conversation and re-join voice — so the only job here is to make the
 *   reconnect happen now, with a live token (services/socket.ts).
 * - The socket stayed connected (or there is none to reconnect: an account
 *   that cannot hold a live session has no socket object at all): nothing
 *   was missed, but a presence slice or a DM list may still have gone stale
 *   (a browser can freeze a hidden page without dropping its socket), so the
 *   cheap ones are refetched.
 *
 * Nothing goes out while the browser says it is offline — the mark-read
 * write included: the `online` event calls this again, and a burst of failed
 * requests on a laptop that has not found its network yet would only toast
 * "failed to load" at the user.
 *
 * The unread counter of the view on screen is cleared locally in every case:
 * the socket may have reconnected in the background and `unread:init`
 * restored a count for a channel the user was reading all along.
 */
export async function handleAppResume(): Promise<void> {
  const serverState = useServerStore.getState();
  const dmState = useDMStore.getState();
  // Only when actually in server view — activeChannelId survives switching to DMs
  const viewedChannelId = serverState.activeServerId ? serverState.activeChannelId : null;
  const viewedConversationId = serverState.activeServerId ? null : dmState.activeConversationId;

  if (viewedChannelId) serverState.clearUnread(viewedChannelId);
  if (viewedConversationId) dmState.clearDMUnread(viewedConversationId);

  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;

  // The server's copy of "read up to now" (a POST; retried once by the store)
  if (viewedChannelId) serverState.markChannelRead(viewedChannelId);
  if (viewedConversationId) dmState.markConversationRead(viewedConversationId);

  const socket = getSocket();
  if (socket && !socket.connected) {
    await ensureSocketConnected();
    return;
  }

  // Re-fetch data that may have become stale while the tab was hidden
  void dmState.fetchConversations();
  if (serverState.activeServerId) {
    void serverState.fetchPeople(serverState.activeServerId);
  }
}
