// Display-layer glue between SECURE-CHANNEL stores/components and the E2E
// service — the channel sibling of dmCrypto.ts. Group-session state is keyed
// by the scope `ch:{channelId}` (shared e2eChannelScope), which is what flows
// through the service's `conversationId` parameters.
//
// NOTE: stores are imported DYNAMICALLY inside functions. resetStores.ts
// captures every account store's initial state at module-eval time, so a
// static store import from a service pulled in by chatStore would create an
// eval-order cycle that crashes at boot (same rule as dmCrypto.ts).
import { buildE2EPlaintext, parseE2EPlaintext, e2eChannelScope } from '@voxium/shared';
import type { Message, E2EAttachmentMeta } from '@voxium/shared';
import { getE2EService, E2EIdentityChangedError } from './e2eService';
import { DECRYPT_FAILED_CONTENT } from './dmCrypto';

export { E2EIdentityChangedError, DECRYPT_FAILED_CONTENT };

/** Split raw decrypted plaintext into display fields on a message. */
function applyPlaintext(message: Message, raw: string): Message {
  const { text, attachments } = parseE2EPlaintext(raw);
  return { ...message, content: text, ...(attachments.length > 0 && { e2eAttachments: attachments }) };
}

async function currentUserId(): Promise<string | null> {
  const { useAuthStore } = await import('../../stores/authStore');
  return useAuthStore.getState().user?.id ?? null;
}

async function resolveReplyPreview(message: Message, userId: string): Promise<Message> {
  if (!message.replyTo?.encrypted) return message;
  const cached = await getE2EService(userId).getCachedPlaintext(message.replyTo.id);
  const preview = cached ? parseE2EPlaintext(cached).text : '';
  return { ...message, replyTo: { ...message.replyTo, content: preview } };
}

/**
 * Decrypt one secure-channel message for display.
 *
 * The `encrypted: false` refusal mirrors dmCrypto: a secure channel has no
 * plaintext user-message path, so an unencrypted `type: 'user'` row can only
 * be a server-side forgery — honouring it would put words under a member's
 * name with no decrypt-failure marker. The flag is the server's word; it does
 * not get to decide whether a message was end-to-end encrypted.
 */
export async function decryptChannelMessageForDisplay(message: Message): Promise<Message> {
  if (!message.encrypted) {
    if (message.type === 'system') return message;
    console.warn(
      `e2e: refusing an unencrypted message (${message.id}) in a secure channel`
    );
    return { ...message, content: DECRYPT_FAILED_CONTENT };
  }
  if (!message.channelId) return { ...message, content: DECRYPT_FAILED_CONTENT };
  const userId = await currentUserId();
  if (!userId) return { ...message, content: DECRYPT_FAILED_CONTENT };

  const service = getE2EService(userId);
  const scope = e2eChannelScope(message.channelId);
  const own = message.author?.id === userId;

  const result = await service.decryptMessage({
    id: message.id,
    conversationId: scope,
    authorId: message.author?.id ?? '',
    content: message.content,
    editedAt: message.editedAt ?? null,
    createdAt: message.createdAt,
  });
  if (!result.failed) {
    return resolveReplyPreview(applyPlaintext(message, result.text), userId);
  }

  if (own) {
    // Same race as DMs: the socket echo can beat the POST response that
    // writes the sender's cache entry. Patient retry only for fresh messages.
    const ageMs = Date.now() - new Date(message.createdAt).getTime();
    const attempts = Number.isFinite(ageMs) && ageMs < 10_000 ? 4 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempts > 1) await new Promise((r) => setTimeout(r, 150));
      const cached = await service.getCachedPlaintext(message.id, message.editedAt ?? null);
      if (cached !== null) {
        return resolveReplyPreview(applyPlaintext(message, cached), userId);
      }
    }
  }
  return resolveReplyPreview({ ...message, content: DECRYPT_FAILED_CONTENT }, userId);
}

/** Decrypt a fetched page of secure-channel messages (order preserved). */
export async function decryptChannelMessagesForDisplay(messages: Message[]): Promise<Message[]> {
  // No short-circuit on `some(m => m.encrypted)` — same forged-plaintext-page
  // reasoning as dmCrypto.decryptMessagesForDisplay.
  if (messages.length === 0) return messages;
  const out: Message[] = [];
  for (const m of messages) {
    try {
      out.push(await decryptChannelMessageForDisplay(m));
    } catch (err) {
      console.error(`e2e: decrypt pipeline failed for message ${m.id}:`, err);
      out.push({ ...m, content: DECRYPT_FAILED_CONTENT });
    }
  }
  return out;
}

/**
 * Prepare an outgoing secure-channel message: ciphertext envelope + the exact
 * raw plaintext (for the sender's cache) + the members who cannot read yet
 * (no published E2E device — surfaced by the UI, never silently dropped).
 * Identity changes are flagged for the UI and rethrown — the message must NOT
 * be sent until the user accepts the new identity.
 */
export async function prepareOutgoingChannelMessage(
  channelId: string,
  text: string,
  attachments?: E2EAttachmentMeta[]
): Promise<{ content: string; plaintext: string; notReadyUserIds: string[] }> {
  const userId = await currentUserId();
  if (!userId) throw new Error('Not authenticated');

  const plaintext = buildE2EPlaintext(text, attachments);
  try {
    const { envelope, notReadyUserIds } = await getE2EService(userId).encryptChannelMessage(
      channelId,
      plaintext
    );
    return { content: envelope, plaintext, notReadyUserIds };
  } catch (err) {
    if (err instanceof E2EIdentityChangedError) {
      const { useE2EStore } = await import('../../stores/e2eStore');
      useE2EStore.getState().flagIdentityChanged(err.peerUserId);
    }
    throw err;
  }
}

/** Store the sent plaintext under the server-assigned message id + version. */
export async function cacheSentChannelPlaintext(
  messageId: string,
  channelId: string,
  plaintext: string,
  editedAt?: string | null,
  createdAt?: string
): Promise<void> {
  const userId = await currentUserId();
  if (!userId) return;
  await getE2EService(userId).cachePlaintext(messageId, e2eChannelScope(channelId), plaintext, editedAt, {
    authorId: userId,
    ...(createdAt && { createdAt }),
  });
}

/**
 * Client-side search of a secure channel: the server is structurally blind to
 * ciphertext, so results come from this device's plaintext cache. Authors are
 * resolved from the server member list (channel members are server members).
 */
export async function searchEncryptedChannelHistory(
  channelId: string,
  query: string
): Promise<Message[]> {
  const userId = await currentUserId();
  if (!userId) return [];
  const { useAuthStore } = await import('../../stores/authStore');
  const { useServerStore } = await import('../../stores/serverStore');
  const me = useAuthStore.getState().user;
  const members = useServerStore.getState().members;

  const hits = (await getE2EService(userId).searchDecrypted(e2eChannelScope(channelId), query))
    .filter((hit) => hit.createdAt);
  return hits.map((hit) => {
    const member = hit.authorId ? members.find((m) => m.userId === hit.authorId) : undefined;
    const author = hit.authorId === userId && me
      ? { id: me.id, username: me.username, displayName: me.displayName, avatarUrl: me.avatarUrl }
      : member
        ? {
            id: member.user.id,
            username: member.user.username,
            displayName: member.user.displayName,
            avatarUrl: member.user.avatarUrl,
          }
        : { id: hit.authorId ?? '', username: '', displayName: '?', avatarUrl: null };
    return {
      id: hit.messageId,
      content: hit.text,
      encrypted: true,
      type: 'user',
      channelId,
      conversationId: null,
      author,
      createdAt: hit.createdAt ?? '',
      editedAt: hit.editedAt ?? null,
      reactions: [],
    } as Message;
  });
}
