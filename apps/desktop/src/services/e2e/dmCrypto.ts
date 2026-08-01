// Display-layer glue between DM stores/components and the E2E service.
// Plaintext messages pass through untouched; encrypted ones are decrypted (or
// resolved from the local cache) before they reach any store or the DOM.
//
// NOTE: stores are imported DYNAMICALLY inside functions. resetStores.ts
// captures every account store's initial state at module-eval time, so a
// static store import from a service pulled in by chatStore would create an
// eval-order cycle that crashes at boot.
import { buildE2EPlaintext, parseE2EPlaintext } from '@voxium/shared';
import type { Message, E2EAttachmentMeta } from '@voxium/shared';
import { getE2EService, E2EIdentityChangedError } from './e2eService';

export { E2EIdentityChangedError };

/** Split raw decrypted plaintext into display fields on a message. */
function applyPlaintext(message: Message, raw: string): Message {
  const { text, attachments } = parseE2EPlaintext(raw);
  return { ...message, content: text, ...(attachments.length > 0 && { e2eAttachments: attachments }) };
}

async function currentUserId(): Promise<string | null> {
  const { useAuthStore } = await import('../../stores/authStore');
  return useAuthStore.getState().user?.id ?? null;
}

/** Marker the UI renders as "unable to decrypt" (never shown as user text). */
export const DECRYPT_FAILED_CONTENT = '';

async function resolveReplyPreview(message: Message, userId: string): Promise<Message> {
  if (!message.replyTo?.encrypted) return message;
  const cached = await getE2EService(userId).getCachedPlaintext(message.replyTo.id);
  // cached entries hold raw plaintext — structured payloads carry the text field
  const preview = cached ? parseE2EPlaintext(cached).text : '';
  return { ...message, replyTo: { ...message.replyTo, content: preview } };
}

/**
 * Decrypt one message for display. Megolm messages decrypt on every device of
 * both participants (including our own sends), so the normal path handles them.
 * Own echoes can still race the send path's cache write, and legacy olm1 own
 * messages are cache-only, so own messages fall back to retrying the cache.
 */
export async function decryptMessageForDisplay(message: Message): Promise<Message> {
  if (!message.encrypted) return message;
  const userId = await currentUserId();
  if (!userId) return { ...message, content: DECRYPT_FAILED_CONTENT };

  const service = getE2EService(userId);
  const own = message.author?.id === userId;

  const result = await service.decryptMessage({
    id: message.id,
    conversationId: message.conversationId ?? '',
    authorId: message.author?.id ?? '',
    content: message.content,
    editedAt: message.editedAt ?? null,
    createdAt: message.createdAt,
  });
  if (!result.failed) {
    return resolveReplyPreview(applyPlaintext(message, result.text), userId);
  }

  if (own) {
    // The socket echo can beat the POST response that writes the cache entry.
    for (let attempt = 0; attempt < 4; attempt++) {
      await new Promise((r) => setTimeout(r, 150));
      // version-checked: an edit echo must not serve the pre-edit cache entry
      const cached = await service.getCachedPlaintext(message.id, message.editedAt ?? null);
      if (cached !== null) {
        return resolveReplyPreview(applyPlaintext(message, cached), userId);
      }
    }
  }
  return resolveReplyPreview({ ...message, content: DECRYPT_FAILED_CONTENT }, userId);
}

/** Decrypt a fetched page of messages (order preserved; plaintext untouched). */
export async function decryptMessagesForDisplay(messages: Message[]): Promise<Message[]> {
  if (!messages.some((m) => m.encrypted)) return messages;
  // Sequential on purpose: decryption mutates ratchet state through a serial
  // queue anyway, and order here matches timeline order for skipped-key bookkeeping.
  const out: Message[] = [];
  for (const m of messages) {
    out.push(await decryptMessageForDisplay(m));
  }
  return out;
}

/**
 * Prepare an outgoing DM: returns the ciphertext envelope and the exact raw
 * plaintext that was encrypted (for the sender's cache). Every conversation is
 * encrypted, so there is no "plaintext conversation" result — the only way this
 * cannot produce ciphertext is the conversation not being loaded, which is a
 * fault, not a fallback. Attachment metas — real names/keys — go inside the
 * ciphertext, never in the returned envelope's surroundings. Identity changes
 * are flagged for the UI and rethrown — the message must NOT be sent.
 */
export async function prepareOutgoingDM(
  conversationId: string,
  text: string,
  attachments?: E2EAttachmentMeta[]
): Promise<{ content: string; plaintext: string }> {
  const { useDMStore } = await import('../../stores/dmStore');
  const conversation = useDMStore.getState().conversations.find((c) => c.id === conversationId);
  // The peer id drives the session fanout, so a conversation the store has not
  // loaded cannot be encrypted to anyone — and must not degrade to a plaintext
  // send the server would reject anyway (plan §4.2).
  if (!conversation) throw new Error(`Conversation ${conversationId} is not loaded`);

  const userId = await currentUserId();
  if (!userId) throw new Error('Not authenticated');

  const plaintext = buildE2EPlaintext(text, attachments);
  try {
    // group session per conversation — the peer id drives the share fanout
    const content = await getE2EService(userId).encryptMessage(
      conversationId,
      conversation.participant.id,
      plaintext
    );
    return { content, plaintext };
  } catch (err) {
    if (err instanceof E2EIdentityChangedError) {
      const { useE2EStore } = await import('../../stores/e2eStore');
      useE2EStore.getState().flagIdentityChanged(err.peerUserId);
    }
    throw err;
  }
}

/** Store the sent plaintext under the server-assigned message id + version. */
export async function cacheSentPlaintext(
  messageId: string,
  conversationId: string,
  plaintext: string,
  editedAt?: string | null,
  createdAt?: string
): Promise<void> {
  const userId = await currentUserId();
  if (!userId) return;
  await getE2EService(userId).cachePlaintext(messageId, conversationId, plaintext, editedAt, {
    authorId: userId,
    ...(createdAt && { createdAt }),
  });
}

/**
 * Client-side search of an encrypted conversation (spec §9): the server only
 * holds ciphertext, so encrypted DMs are searched over this device's local
 * plaintext cache. Returns rows shaped like server SearchResults so the
 * search UI can render either source.
 */
export async function searchEncryptedHistory(
  conversationId: string,
  query: string
): Promise<Message[]> {
  const userId = await currentUserId();
  if (!userId) return [];
  const { useAuthStore } = await import('../../stores/authStore');
  const { useDMStore } = await import('../../stores/dmStore');
  const me = useAuthStore.getState().user;
  const conversation = useDMStore.getState().conversations.find((c) => c.id === conversationId);

  const hits = (await getE2EService(userId).searchDecrypted(conversationId, query))
    // pre-Phase-C cache entries lack createdAt — they can't be rendered or
    // jumped to reliably, so they're excluded rather than shown broken
    .filter((hit) => hit.createdAt);
  return hits.map((hit) => {
    // Resolve the author from the two possible DM participants; pre-Phase-C
    // cache entries have no authorId and render anonymously rather than wrong
    const author = hit.authorId === userId && me
      ? { id: me.id, username: me.username, displayName: me.displayName, avatarUrl: me.avatarUrl }
      : hit.authorId && hit.authorId === conversation?.participant.id
        ? conversation.participant
        : { id: hit.authorId ?? '', username: '', displayName: '?', avatarUrl: null };
    return {
      id: hit.messageId,
      content: hit.text,
      encrypted: true,
      type: 'user',
      channelId: null,
      conversationId,
      author,
      createdAt: hit.createdAt ?? '',
      editedAt: hit.editedAt ?? null,
      reactions: [],
    } as Message;
  });
}

/** Resolve an encrypted conversation-list preview from the local cache. */
export async function resolveEncryptedPreview(messageId: string): Promise<string | null> {
  const userId = await currentUserId();
  if (!userId) return null;
  return getE2EService(userId).getCachedPlaintext(messageId);
}
