import { create } from 'zustand';
import axios from 'axios';
import { api } from '../services/api';
import { getSocket } from '../services/socket';
import { toast } from './toastStore';
import i18n from '../i18n';
import { useDMStore } from './dmStore';
import { DMConversationReadOnlyError, isHeldReadOnly } from '../utils/dmParticipant';
import { useServerStore } from './serverStore';
import { E2EPeerNotReadyError } from '../services/e2e/e2eService';
import { decryptMessagesForDisplay, prepareOutgoingDM, cacheSentPlaintext } from '../services/e2e/dmCrypto';
import { isDeletedMessageRow, ownSentRow } from '../services/e2e/displayGate';
import { isNewerVersion } from '../services/e2e/undecryptedRows';
import { isSecureChannelId } from '../utils/secureChannelGate';
import {
  decryptChannelMessagesForDisplay,
  prepareOutgoingChannelMessage,
  cacheSentChannelPlaintext,
} from '../services/e2e/channelCrypto';
import { E2E_ATTACHMENT_MIME, E2E_ATTACHMENT_NAME, E2E_GCM_TAG_BYTES, WEBHOOK_AUTHOR_ID_PREFIX } from '@voxium/shared';
import type { Message, MessageAuthor, Attachment, ReactionGroup, E2EAttachmentMeta } from '@voxium/shared';

/** The store holds the conversation read-only (the other side's account was deleted: utils/dmParticipant.ts). */
function isConversationReadOnly(conversationId: string): boolean {
  return isHeldReadOnly(useDMStore.getState(), conversationId);
}

// Track typing timers per user to prevent leaks
const typingTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Secure channels: the loaded channel list OR this device's pin (utils/secureChannelGate.ts) — never the server's flag alone. */
function isSecureChannel(channelId: string): boolean {
  return isSecureChannelId(channelId, useServerStore.getState().channels);
}

// Track current fetch to prevent duplicate requests
let activeFetchController: AbortController | null = null;
let lastFetchKey = '';

/**
 * A channel or a conversation, as the chat view's scope (one list serves
 * both). The view's own is recorded from the argument of the fetch that
 * opened it, never from a field of a row it holds (a plaintext row carries
 * whatever the server wrote); a write names the one it is for: a send the
 * one it was sent to, a socket handler the one its event names. An empty id
 * names none.
 */
export interface ChatViewScope {
  readonly kind: 'channel' | 'conversation';
  readonly id: string;
}

export function channelView(channelId: string | null | undefined): ChatViewScope {
  return { kind: 'channel', id: channelId ?? '' };
}

export function conversationView(conversationId: string | null | undefined): ChatViewScope {
  return { kind: 'conversation', id: conversationId ?? '' };
}

/** Whether two scopes name the same channel, or the same conversation (the kind counts: a channel and a conversation of one id are two). */
export function isSameView(a: ChatViewScope | null, b: ChatViewScope | null): boolean {
  return !!a && !!b && a.id !== '' && a.kind === b.kind && a.id === b.id;
}

/**
 * How long the view remembers the newest version of a row it does not show
 * yet (an edit whose page or insert is still on its way). It is never wrong
 * later (an older version stays older), so the bound only caps memory: an
 * entry serves a gate call or a page request that began before its event and
 * ends after it, and every change of view drops them all (startView). A
 * call that outlives it (a long key-share claim, a request on a stalled
 * network: the API sets no timeout) can show the row as it was then, until
 * the next fetch.
 */
export const RECENT_CHANGE_MAX_AGE_MS = 5 * 60_000;
/** Such entries at most; the oldest goes first beyond. */
export const RECENT_CHANGES_MAX = 500;

/** By message id, oldest first: the version not shown yet. */
const recentChanges = new Map<string, { at: number; row: Message }>();

/**
 * A new view, of `scope` (a fetch of another channel or conversation than the
 * one recorded) or of none (a clear, a logout): the rows, the reply being
 * composed, the typing line and everything the last view remembered go, and
 * its page in flight is aborted. Synchronous, so a fetch's page is merged
 * with nothing of another scope, and nothing of another scope is shown while
 * it is on its way. With no scope recorded, every writer drops what it brings.
 */
function startView(scope: ChatViewScope | null): void {
  if (activeFetchController) {
    activeFetchController.abort();
    activeFetchController = null;
  }
  lastFetchKey = '';
  recentChanges.clear();
  typingTimers.forEach((timer) => clearTimeout(timer));
  typingTimers.clear();
  useChatStore.setState({
    messages: [], hasMore: false, hasMoreAfter: false, isLoading: false, typingUsers: new Map(),
    replyingTo: null, targetMessageId: null, viewScope: scope,
  });
}

/** A fetch of `scope`: a change of view first when the view is of another one, or of none. */
function viewFor(scope: ChatViewScope): void {
  if (!isSameView(useChatStore.getState().viewScope, scope)) startView(scope);
}

/** Whether `scope` is the one the view's rows belong to. */
function isViewOf(scope: ChatViewScope): boolean {
  return isSameView(useChatStore.getState().viewScope, scope);
}

/**
 * Whether the view is of a conversation the DM store holds read-only (the
 * other side's account was deleted): the deleted shapes it holds stand over
 * any other copy then. Asked of the recorded scope, never of a row.
 */
function viewHeldReadOnly(): boolean {
  const scope = useChatStore.getState().viewScope;
  return scope?.kind === 'conversation' && isConversationReadOnly(scope.id);
}

/**
 * The conversation on screen is left (dmStore's clearActiveConversation: the
 * friends or support view, the Messages tab, a space's tab or the switcher):
 * a new view of none starts only when the view is a conversation's. A
 * channel's view, or none, is left as it is: a space can be on screen with a
 * conversation kept open behind it (a space opened from Explore, an invite,
 * a new space or the voice panel), and leaving that conversation changes
 * nothing the space shows.
 */
export function clearConversationView(): void {
  if (useChatStore.getState().viewScope?.kind === 'conversation') startView(null);
}

/**
 * Logout (resetAccountStores): a page in flight for the leaving account is
 * aborted and lands for nobody, and nothing its view recorded or remembered
 * stays.
 */
export function resetChatViewState(): void {
  startView(null);
}

function rememberChange(messageId: string, row: Message): void {
  recentChanges.delete(messageId);
  recentChanges.set(messageId, { at: Date.now(), row });
  for (const oldest of recentChanges.keys()) {
    if (recentChanges.size <= RECENT_CHANGES_MAX) break;
    recentChanges.delete(oldest);
  }
}

/** What the view remembers of a message: a version it does not show yet, or undefined (nothing). */
function recentChangeOf(messageId: string): Message | undefined {
  const now = Date.now();
  // an age below zero (the clock stepped back) keeps an entry: it is never wrong, only old
  for (const [id, change] of recentChanges) {
    if (now - change.at < RECENT_CHANGE_MAX_AGE_MS) break;
    recentChanges.delete(id);
  }
  return recentChanges.get(messageId)?.row;
}

/**
 * Which of two copies of one message the view shows: the one it `held` (its
 * row, or a version it did not show yet) or the `incoming` one. A deleted
 * account's row (the gate's deleted shape) that comes in stands over any
 * other copy, and one held stands while `readOnly` (the view is of a
 * conversation held read-only); then a copy that is provably the newer
 * version (isNewerVersion); then the path's own rule, `onEven`: an insert
 * keeps the copy held (whichever of the sender's row and the socket echo
 * lands first owns the id), an edit and a page take the incoming one.
 */
function pickVersion(held: Message, incoming: Message, onEven: 'held' | 'incoming', readOnly: boolean): Message {
  if (isDeletedMessageRow(incoming)) return incoming;
  if (readOnly && isDeletedMessageRow(held)) return held;
  if (isNewerVersion(incoming, held)) return incoming;
  if (isNewerVersion(held, incoming)) return held;
  return onEven === 'held' ? held : incoming;
}

function replacedAt(messages: readonly Message[], index: number, row: Message): Message[] {
  const next = messages.slice();
  next[index] = row;
  return next;
}

/**
 * A fetched page as the view takes it, against the rows it shows (always of
 * the page's own channel or conversation: a fetch of another one started a
 * new view first): each row is the copy pickVersion keeps of the page's, a
 * version the view did not show yet (taken now) and the one it shows
 * (`onEven` for the last). A page asked for before an edit and answered
 * after it never puts the older version over the newer one.
 */
function resolvePage(page: readonly Message[], shown: readonly Message[], onEven: 'held' | 'incoming'): Message[] {
  const held = new Map(shown.map((m) => [m.id, m]));
  const readOnly = viewHeldReadOnly();
  const out: Message[] = [];
  for (const row of page) {
    const change = recentChangeOf(row.id);
    let kept = row;
    if (change) {
      kept = pickVersion(change, kept, 'incoming', readOnly);
      recentChanges.delete(row.id);
    }
    const mine = held.get(row.id);
    out.push(mine ? pickVersion(mine, kept, onEven, readOnly) : kept);
  }
  return out;
}

/** An older page (`before`) in front of the rows shown; a row both hold keeps the copy shown unless the page's is provably newer. */
function withOlderPage(page: readonly Message[], shown: readonly Message[]): Message[] {
  const resolved = resolvePage(page, shown, 'held');
  const shownIds = new Set(shown.map((m) => m.id));
  const both = new Map(resolved.filter((m) => shownIds.has(m.id)).map((m) => [m.id, m]));
  return [...resolved.filter((m) => !shownIds.has(m.id)), ...shown.map((m) => both.get(m.id) ?? m)];
}

interface ChatState {
  messages: Message[];
  /**
   * The channel or conversation `messages` belong to, or null (none yet).
   * Written by the store alone: every fetch records what it asks for (a new
   * view when it differs), a clear and a logout record none.
   */
  viewScope: ChatViewScope | null;
  hasMore: boolean;
  hasMoreAfter: boolean;
  isLoading: boolean;
  typingUsers: Map<string, string>; // userId -> username
  replyingTo: Message | null;
  targetMessageId: string | null;

  setReplyingTo: (message: Message | null) => void;
  clearReplyingTo: () => void;
  fetchMessages: (channelId: string, before?: string) => Promise<void>;
  fetchMessagesAround: (channelId: string, messageId: string) => Promise<void>;
  sendMessage: (channelId: string, content: string, attachments?: Omit<Attachment, 'id' | 'expired'>[], e2eAttachments?: E2EAttachmentMeta[]) => Promise<void>;
  editMessage: (channelId: string, messageId: string, content: string) => Promise<void>;
  requestDeleteMessage: (channelId: string, messageId: string) => Promise<void>;
  toggleReaction: (channelId: string, messageId: string, emoji: string) => Promise<void>;
  fetchDMMessages: (conversationId: string, before?: string) => Promise<void>;
  fetchDMMessagesAround: (conversationId: string, messageId: string) => Promise<void>;
  /** DMs are always E2E, so attachments only ever travel as E2E metas — there
   *  is no plaintext-attachment parameter to pass. */
  sendDMMessage: (conversationId: string, content: string, e2eAttachments?: E2EAttachmentMeta[]) => Promise<void>;
  editDMMessage: (conversationId: string, messageId: string, content: string) => Promise<void>;
  requestDeleteDMMessage: (conversationId: string, messageId: string) => Promise<void>;
  toggleDMReaction: (conversationId: string, messageId: string, emoji: string) => Promise<void>;
  /**
   * A new row written for `scope` (the channel or conversation the caller
   * sent to, or the socket event names); true when the view took it as a new
   * row. Nothing for another scope than the view's (or none recorded), or a
   * copy of a row it shows (it keeps that one unless this is provably newer).
   */
  addMessage: (message: Message, scope: ChatViewScope) => boolean;
  /**
   * A row's new version, written for `scope`; true when the view shows it.
   * Nothing for another scope (not kept either); a provably newer version
   * held stands, and a row the view does not show yet is remembered for its
   * insert or its page.
   */
  updateMessage: (message: Message, scope: ChatViewScope) => boolean;
  /** A row's reactions, for `scope` (nothing for another one). */
  updateMessageReactions: (messageId: string, reactions: ReactionGroup[], scope: ChatViewScope) => void;
  deleteMessage: (messageId: string) => void;
  /**
   * Drops every loaded row a webhook posted in a channel (`message:bulk_deleted`,
   * a webhook deleted with purge), when the view is of that channel.
   */
  removeWebhookMessages: (channelId: string, webhookId: string) => void;
  clearMessages: () => void;
  clearTargetMessage: () => void;
  setTypingUser: (userId: string, username: string) => void;
  removeTypingUser: (userId: string) => void;
  updateAuthorAvatar: (userId: string, avatarUrl: string | null) => void;
  updateAuthorProfile: (userId: string, fields: Partial<MessageAuthor>) => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  viewScope: null,
  hasMore: false,
  hasMoreAfter: false,
  isLoading: false,
  typingUsers: new Map(),
  replyingTo: null,
  targetMessageId: null,

  setReplyingTo: (message) => {
    // nobody is answered in a read-only conversation (the other side's account was deleted)
    if (message?.conversationId && isConversationReadOnly(message.conversationId)) return;
    set({ replyingTo: message });
  },
  clearReplyingTo: () => set({ replyingTo: null }),

  fetchMessages: async (channelId: string, before?: string) => {
    // the view is of this channel from here on: another one's rows, kept
    // changes and page in flight go first
    viewFor(channelView(channelId));
    // Deduplicate: skip if same request is already in-flight
    const fetchKey = `${channelId}:${before || 'initial'}`;
    if (fetchKey === lastFetchKey && get().isLoading) return;

    // Abort any previous pending fetch (e.g. rapid channel switching)
    if (activeFetchController) {
      activeFetchController.abort();
    }

    const controller = new AbortController();
    activeFetchController = controller;
    lastFetchKey = fetchKey;

    set({ isLoading: true });
    try {
      const params = new URLSearchParams();
      if (before) params.set('before', before);

      const { data } = await api.get(`/channels/${channelId}/messages?${params}`, {
        signal: controller.signal,
      });
      // Secure channels: ciphertext never reaches the store or the DOM
      const newMessages = isSecureChannel(channelId)
        ? await decryptChannelMessagesForDisplay(data.data)
        : data.data;

      // Check if this fetch is still relevant (channel may have changed)
      if (controller.signal.aborted) return;

      if (before) {
        set({ messages: withOlderPage(newMessages, get().messages), hasMore: data.hasMore, isLoading: false });
      } else {
        set({ messages: resolvePage(newMessages, get().messages, 'incoming'), hasMore: data.hasMore, hasMoreAfter: false, isLoading: false });
      }
    } catch (err) {
      if (axios.isCancel(err)) return;
      console.error('Failed to fetch messages:', err);
      toast.error(i18n.t('chat.failedToLoadMessages'));
      set({ isLoading: false });
    } finally {
      if (activeFetchController === controller) {
        activeFetchController = null;
      }
    }
  },

  fetchMessagesAround: async (channelId: string, messageId: string) => {
    viewFor(channelView(channelId));
    if (activeFetchController) {
      activeFetchController.abort();
    }

    const controller = new AbortController();
    activeFetchController = controller;
    lastFetchKey = `${channelId}:around:${messageId}`;

    set({ isLoading: true });
    try {
      const { data } = await api.get(`/channels/${channelId}/messages?around=${messageId}`, {
        signal: controller.signal,
      });
      const around = isSecureChannel(channelId)
        ? await decryptChannelMessagesForDisplay(data.data)
        : data.data;

      if (controller.signal.aborted) return;

      set({
        messages: resolvePage(around, get().messages, 'incoming'),
        hasMore: data.hasMore,
        hasMoreAfter: data.hasMoreAfter ?? false,
        targetMessageId: data.targetMessageId ?? messageId,
        isLoading: false,
      });
    } catch (err) {
      if (axios.isCancel(err)) return;
      console.error('Failed to fetch messages around:', err);
      toast.error(i18n.t('chat.failedToLoadMessages'));
      set({ isLoading: false });
    } finally {
      if (activeFetchController === controller) {
        activeFetchController = null;
      }
    }
  },

  sendMessage: async (
    channelId: string,
    content: string,
    attachments?: Omit<Attachment, 'id' | 'expired'>[],
    e2eAttachments?: E2EAttachmentMeta[],
  ) => {
    // its own row lands when the view is of this channel at the POST's answer
    // (a reload of the channel meanwhile included: its page may have been
    // read before the message was), and in no other channel or conversation
    const sentTo = channelView(channelId);
    try {
      const replyingTo = get().replyingTo;

      if (isSecureChannel(channelId)) {
        // Secure channels mirror the DM send: encrypt before anything leaves
        // the client; real attachment metadata travels inside the ciphertext.
        const prepared = await prepareOutgoingChannelMessage(channelId, content, e2eAttachments);
        if (prepared.notReadyUserIds.length > 0) {
          // The channel's own member list names everyone in it; the server's
          // known rows are only a slice of a big server
          const { members, secureChannelMembers } = useServerStore.getState();
          const channelMembers = secureChannelMembers[channelId] ?? [];
          const names = prepared.notReadyUserIds
            .map((id) => channelMembers.find((m) => m.userId === id)?.user.displayName
              ?? members.find((m) => m.userId === id)?.user.displayName ?? id)
            .join(', ');
          toast.error(i18n.t('secureChannel.membersNotReady', { names }));
        }

        const body: Record<string, unknown> = { content: prepared.content, encrypted: true };
        if (replyingTo) body.replyToId = replyingTo.id;
        if (e2eAttachments?.length) {
          body.attachments = e2eAttachments.map((meta) => ({
            s3Key: meta.s3Key,
            fileName: E2E_ATTACHMENT_NAME,
            fileSize: meta.fileSize + E2E_GCM_TAG_BYTES, // ciphertext size
            mimeType: E2E_ATTACHMENT_MIME,
          }));
        }

        const { data } = await api.post(`/channels/${channelId}/messages`, body);
        const raw: Message = data.data;
        await cacheSentChannelPlaintext(raw.id, channelId, prepared.plaintext, null, raw.createdAt, prepared.position);
        // Built from what this client knows, not from the server's reply:
        // whichever of this row and the gated socket echo lands first owns
        // the id (the other is dropped by addMessage's dedupe), so nothing
        // the server put in the POST response may ride on it
        get().addMessage(ownSentRow(raw, { content, replyingTo, e2eAttachments }), sentTo);
      } else {
        const body: Record<string, unknown> = { content };
        if (replyingTo) body.replyToId = replyingTo.id;
        if (attachments?.length) body.attachments = attachments;

        const { data } = await api.post(`/channels/${channelId}/messages`, body);
        // The message will be added via WebSocket, but we also handle it here as fallback
        get().addMessage(data.data, sentTo);
      }

      if (replyingTo) set({ replyingTo: null });

      const socket = getSocket();
      if (socket) {
        socket.emit('typing:stop', channelId);
      }
    } catch (err) {
      console.error('Failed to send message:', err);
      throw err;
    }
  },

  editMessage: async (channelId: string, messageId: string, content: string) => {
    if (isSecureChannel(channelId)) {
      // An edit is a fresh ciphertext for the same id (mirrors editDMMessage)
      const prepared = await prepareOutgoingChannelMessage(channelId, content);
      const { data } = await api.patch(`/channels/${channelId}/messages/${messageId}`, {
        content: prepared.content,
        encrypted: true,
      });
      // cache under the new editedAt version BEFORE the socket echo decrypts it
      await cacheSentChannelPlaintext(
        messageId, channelId, prepared.plaintext, data.data.editedAt ?? null, data.data.createdAt, prepared.position,
      );
      return;
    }
    await api.patch(`/channels/${channelId}/messages/${messageId}`, { content });
  },

  requestDeleteMessage: async (channelId: string, messageId: string) => {
    await api.delete(`/channels/${channelId}/messages/${messageId}`);
  },

  toggleReaction: async (channelId: string, messageId: string, emoji: string) => {
    try {
      await api.put(`/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`);
    } catch (err) {
      console.error('Failed to toggle reaction:', err);
      throw err;
    }
  },

  fetchDMMessages: async (conversationId: string, before?: string) => {
    // the view is of this conversation from here on: a channel's or another
    // conversation's rows, kept changes and page in flight go first
    viewFor(conversationView(conversationId));
    const fetchKey = `dm:${conversationId}:${before || 'initial'}`;
    if (fetchKey === lastFetchKey && get().isLoading) return;

    if (activeFetchController) {
      activeFetchController.abort();
    }

    const controller = new AbortController();
    activeFetchController = controller;
    lastFetchKey = fetchKey;

    set({ isLoading: true });
    try {
      const params = new URLSearchParams();
      if (before) params.set('before', before);

      const { data } = await api.get(`/dm/${conversationId}/messages?${params}`, {
        signal: controller.signal,
      });
      // E2E conversations: ciphertext never reaches the store or the DOM
      // the page is this conversation's: its read-only state and placeholder rows follow it
      const newMessages = await decryptMessagesForDisplay(data.data, { conversationId });

      if (controller.signal.aborted) return;

      if (before) {
        set({ messages: withOlderPage(newMessages, get().messages), hasMore: data.hasMore, isLoading: false });
      } else {
        set({ messages: resolvePage(newMessages, get().messages, 'incoming'), hasMore: data.hasMore, hasMoreAfter: false, isLoading: false });
      }
    } catch (err) {
      if (axios.isCancel(err)) return;
      console.error('Failed to fetch DM messages:', err);
      toast.error(i18n.t('chat.failedToLoadMessages'));
      set({ isLoading: false });
    } finally {
      if (activeFetchController === controller) {
        activeFetchController = null;
      }
    }
  },

  fetchDMMessagesAround: async (conversationId: string, messageId: string) => {
    viewFor(conversationView(conversationId));
    if (activeFetchController) {
      activeFetchController.abort();
    }

    const controller = new AbortController();
    activeFetchController = controller;
    lastFetchKey = `dm:${conversationId}:around:${messageId}`;

    set({ isLoading: true });
    try {
      const { data } = await api.get(`/dm/${conversationId}/messages?around=${messageId}`, {
        signal: controller.signal,
      });
      const decrypted = await decryptMessagesForDisplay(data.data, { conversationId });

      if (controller.signal.aborted) return;

      set({
        messages: resolvePage(decrypted, get().messages, 'incoming'),
        hasMore: data.hasMore,
        hasMoreAfter: data.hasMoreAfter ?? false,
        targetMessageId: data.targetMessageId ?? messageId,
        isLoading: false,
      });
    } catch (err) {
      if (axios.isCancel(err)) return;
      console.error('Failed to fetch DM messages around:', err);
      toast.error(i18n.t('chat.failedToLoadMessages'));
      set({ isLoading: false });
    } finally {
      if (activeFetchController === controller) {
        activeFetchController = null;
      }
    }
  },

  sendDMMessage: async (conversationId: string, content: string, e2eAttachments?: E2EAttachmentMeta[]) => {
    // a read-only conversation takes no message: refused before anything is
    // encrypted or sent (no typing signal either)
    if (isConversationReadOnly(conversationId)) throw new DMConversationReadOnlyError(conversationId);
    // its own row lands when the view is of this conversation at the POST's
    // answer, and in no other conversation or channel (sendMessage's rule)
    const sentTo = conversationView(conversationId);
    try {
      const replyingTo = get().replyingTo;

      // Every DM is encrypted: encrypt before anything leaves the client. Real
      // attachment metadata travels inside the ciphertext; the server only
      // receives opaque rows (s3Key + ciphertext size).
      const prepared = await prepareOutgoingDM(conversationId, content, e2eAttachments);

      const body: Record<string, unknown> = { content: prepared.content, encrypted: true };
      if (replyingTo) body.replyToId = replyingTo.id;
      if (e2eAttachments?.length) {
        body.attachments = e2eAttachments.map((meta) => ({
          s3Key: meta.s3Key,
          fileName: E2E_ATTACHMENT_NAME,
          fileSize: meta.fileSize + E2E_GCM_TAG_BYTES, // ciphertext size
          mimeType: E2E_ATTACHMENT_MIME,
        }));
      }

      const { data } = await api.post(`/dm/${conversationId}/messages`, body);
      const raw: Message = data.data;
      // Cache the exact raw plaintext that was encrypted (Olm can't
      // decrypt-to-self); display fields come from the parsed payload
      await cacheSentPlaintext(raw.id, conversationId, prepared.plaintext, null, raw.createdAt, prepared.position);
      // Built from what this client knows, not from the server's reply (same
      // rule as the secure-channel branch of sendMessage)
      get().addMessage(ownSentRow(raw, { content, replyingTo, e2eAttachments }), sentTo);

      if (replyingTo) set({ replyingTo: null });

      const socket = getSocket();
      if (socket) {
        socket.emit('dm:typing:stop', conversationId);
      }
    } catch (err) {
      // "They have not set up a device yet" is a state of the world, not a
      // fault: say who and why, instead of a generic send failure the user
      // would read as the app being broken.
      if (err instanceof E2EPeerNotReadyError) {
        const conversation = useDMStore.getState().conversations.find((c) => c.id === conversationId);
        toast.error(
          i18n.t('e2e.peerNotReady', {
            name: conversation?.participant.displayName ?? i18n.t('e2e.peerNotReadyFallbackName'),
          })
        );
        throw err;
      }
      console.error('Failed to send DM:', err);
      throw err;
    }
  },

  editDMMessage: async (conversationId: string, messageId: string, content: string) => {
    // a read-only conversation keeps its messages as they are (deleting one's own stays)
    if (isConversationReadOnly(conversationId)) throw new DMConversationReadOnlyError(conversationId);
    // An edit is a fresh ciphertext for the same id
    const prepared = await prepareOutgoingDM(conversationId, content);
    const { data } = await api.patch(`/dm/${conversationId}/messages/${messageId}`, {
      content: prepared.content,
      encrypted: true,
    });
    // cache under the new editedAt version BEFORE the socket echo decrypts it
    await cacheSentPlaintext(
      messageId, conversationId, prepared.plaintext, data.data.editedAt ?? null, data.data.createdAt, prepared.position,
    );
  },

  requestDeleteDMMessage: async (conversationId: string, messageId: string) => {
    await api.delete(`/dm/${conversationId}/messages/${messageId}`);
  },

  toggleDMReaction: async (conversationId: string, messageId: string, emoji: string) => {
    // no reaction is added or taken back in a read-only conversation
    if (isConversationReadOnly(conversationId)) throw new DMConversationReadOnlyError(conversationId);
    try {
      await api.put(`/dm/${conversationId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`);
    } catch (err) {
      console.error('Failed to toggle DM reaction:', err);
      throw err;
    }
  },

  addMessage: (message: Message, scope: ChatViewScope) => {
    // written for another channel or conversation than the view's rows belong to
    if (!isViewOf(scope)) return false;
    const change = recentChangeOf(message.id);
    const readOnly = viewHeldReadOnly();
    const { messages } = get();
    const index = messages.findIndex((m) => m.id === message.id);
    if (index !== -1) {
      const kept = pickVersion(messages[index], message, 'held', readOnly);
      if (kept !== messages[index]) set({ messages: replacedAt(messages, index, kept) });
      return false;
    }
    let row = message;
    if (change) {
      // an edit that arrived before its insert landed
      row = pickVersion(change, message, 'incoming', readOnly);
      recentChanges.delete(message.id);
    }
    set({ messages: [...messages, row] });
    return true;
  },

  updateMessage: (message: Message, scope: ChatViewScope) => {
    // another channel's or conversation's edit is neither shown nor kept
    if (!isViewOf(scope)) return false;
    const change = recentChangeOf(message.id);
    const readOnly = viewHeldReadOnly();
    const { messages } = get();
    const index = messages.findIndex((m) => m.id === message.id);
    if (index === -1) {
      // not shown yet: its insert, or a page, may still be on its way
      rememberChange(message.id, change ? pickVersion(change, message, 'incoming', readOnly) : message);
      return false;
    }
    const kept = pickVersion(messages[index], message, 'incoming', readOnly);
    if (kept === messages[index]) return false;
    set({ messages: replacedAt(messages, index, kept) });
    return true;
  },

  updateMessageReactions: (messageId: string, reactions: ReactionGroup[], scope: ChatViewScope) => {
    if (!isViewOf(scope)) return;
    set((state) => ({
      messages: state.messages.map((m) =>
        m.id === messageId ? { ...m, reactions } : m
      ),
    }));
  },

  deleteMessage: (messageId: string) => {
    set((state) => ({
      messages: state.messages.filter((m) => m.id !== messageId),
    }));
  },

  removeWebhookMessages: (channelId: string, webhookId: string) => {
    // the view is of that channel, or holds nothing of it
    if (!isViewOf(channelView(channelId))) return;
    // BOTH ids must match: chatStore is shared with DMs, and another
    // webhook's rows (or a human's) in the same channel stay
    const quotedAuthorId = WEBHOOK_AUTHOR_ID_PREFIX + webhookId;
    set((state) => ({
      messages: state.messages
        .filter((m) => !(m.channelId === channelId && m.webhookId === webhookId))
        // A reply quoting one of the purged rows loses its quote, as the
        // server's SetNull leaves it (a reply lives in its parent's channel).
        // Untouched rows keep their identity.
        .map((m) => (m.channelId === channelId && m.replyTo?.author.id === quotedAuthorId
          ? { ...m, replyTo: null, replyToId: null }
          : m)),
    }));
  },

  clearMessages: () => {
    // another view, of nothing until a fetch names its channel or conversation:
    // the fetch in flight is aborted, and what this one remembered goes
    startView(null);
  },

  clearTargetMessage: () => set({ targetMessageId: null }),

  setTypingUser: (userId: string, username: string) => {
    // Clear existing timer for this user to prevent accumulation
    const existingTimer = typingTimers.get(userId);
    if (existingTimer) clearTimeout(existingTimer);

    set((state) => {
      const newMap = new Map(state.typingUsers);
      newMap.set(userId, username);
      return { typingUsers: newMap };
    });

    // Auto-remove after 3 seconds
    const timer = setTimeout(() => {
      typingTimers.delete(userId);
      get().removeTypingUser(userId);
    }, 3000);
    typingTimers.set(userId, timer);
  },

  removeTypingUser: (userId: string) => {
    // Clear the timer if it exists
    const timer = typingTimers.get(userId);
    if (timer) {
      clearTimeout(timer);
      typingTimers.delete(userId);
    }

    set((state) => {
      if (!state.typingUsers.has(userId)) return state;
      const newMap = new Map(state.typingUsers);
      newMap.delete(userId);
      return { typingUsers: newMap };
    });
  },

  updateAuthorAvatar: (userId: string, avatarUrl: string | null) => {
    set((state) => ({
      messages: state.messages.map((m) =>
        m.author.id === userId ? { ...m, author: { ...m.author, avatarUrl } } : m
      ),
    }));
  },

  updateAuthorProfile: (userId: string, fields: Partial<MessageAuthor>) => {
    set((state) => ({
      messages: state.messages.map((m) =>
        m.author.id === userId ? { ...m, author: { ...m.author, ...fields } } : m
      ),
    }));
  },
}));
