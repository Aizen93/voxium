// Display-layer glue between DM stores/components and the E2E service.
// Plaintext messages pass through untouched; encrypted ones are decrypted (or
// resolved from the local cache) before they reach any store or the DOM.
//
// NOTE: stores are imported DYNAMICALLY inside functions. resetStores.ts
// captures every account store's initial state at module-eval time, so a
// static store import from a service pulled in by chatStore would create an
// eval-order cycle that crashes at boot.
import type { Message } from '@voxium/shared';
import { getE2EService, E2EIdentityChangedError } from './e2eService';

export { E2EIdentityChangedError };

async function currentUserId(): Promise<string | null> {
  const { useAuthStore } = await import('../../stores/authStore');
  return useAuthStore.getState().user?.id ?? null;
}

/** Marker the UI renders as "unable to decrypt" (never shown as user text). */
export const DECRYPT_FAILED_CONTENT = '';

async function resolveReplyPreview(message: Message, userId: string): Promise<Message> {
  if (!message.replyTo?.encrypted) return message;
  const cached = await getE2EService(userId).getCachedPlaintext(message.replyTo.id);
  return { ...message, replyTo: { ...message.replyTo, content: cached ?? '' } };
}

/**
 * Decrypt one message for display. Own encrypted echoes race the send path's
 * cache write (the socket broadcast can beat the POST response), so own
 * messages retry the cache briefly before reporting failure.
 */
export async function decryptMessageForDisplay(message: Message): Promise<Message> {
  if (!message.encrypted) return message;
  const userId = await currentUserId();
  if (!userId) return { ...message, content: DECRYPT_FAILED_CONTENT };

  const service = getE2EService(userId);

  if (message.author?.id === userId) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const cached = await service.getCachedPlaintext(message.id);
      if (cached !== null) {
        return resolveReplyPreview({ ...message, content: cached }, userId);
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    return { ...message, content: DECRYPT_FAILED_CONTENT };
  }

  const result = await service.decryptMessage({
    id: message.id,
    conversationId: message.conversationId ?? '',
    authorId: message.author?.id ?? '',
    content: message.content,
  });
  const content = result.failed ? DECRYPT_FAILED_CONTENT : result.text;
  return resolveReplyPreview({ ...message, content }, userId);
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
 * Prepare an outgoing DM: returns the ciphertext envelope when the
 * conversation is E2E, or null for plaintext conversations. Identity changes
 * are flagged for the UI and rethrown — the message must NOT be sent.
 */
export async function prepareOutgoingDM(
  conversationId: string,
  plaintext: string
): Promise<{ content: string } | null> {
  const { useDMStore } = await import('../../stores/dmStore');
  const conversation = useDMStore.getState().conversations.find((c) => c.id === conversationId);
  if (!conversation?.encryptedAt) return null;

  const userId = await currentUserId();
  if (!userId) throw new Error('Not authenticated');

  try {
    const content = await getE2EService(userId).encryptMessage(conversation.participant.id, plaintext);
    return { content };
  } catch (err) {
    if (err instanceof E2EIdentityChangedError) {
      const { useE2EStore } = await import('../../stores/e2eStore');
      useE2EStore.getState().flagIdentityChanged(err.peerUserId);
    }
    throw err;
  }
}

/** Store the sent plaintext under the server-assigned message id. */
export async function cacheSentPlaintext(messageId: string, conversationId: string, plaintext: string): Promise<void> {
  const userId = await currentUserId();
  if (!userId) return;
  await getE2EService(userId).cachePlaintext(messageId, conversationId, plaintext);
}

/** Resolve an encrypted conversation-list preview from the local cache. */
export async function resolveEncryptedPreview(messageId: string): Promise<string | null> {
  const userId = await currentUserId();
  if (!userId) return null;
  return getE2EService(userId).getCachedPlaintext(messageId);
}
