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
  if (!message.encrypted) {
    // After the always-on cutover there is no plaintext DM path: conversations
    // are born encrypted, the enable route is gone, and the send side throws
    // rather than degrade. So the ONLY unencrypted DM rows the server can
    // legitimately produce are its own `type: 'system'` notices (call started,
    // call ended) — which carry no attacker-chosen text.
    //
    // Honouring `encrypted: false` on a `type: 'user'` row would let anyone who
    // can write the API response — a compromised server, a malicious operator,
    // a TLS-terminating hop, all named in spec 1 — put words under a
    // contact's name and avatar with no badge and no decrypt-failure marker,
    // and have them read out in a desktop notification. That is a silent
    // forgery, and it is strictly weaker than the "active key substitution is
    // detectable" property the spec claims. The flag is the server's word, so
    // it does not get to decide whether a message was end-to-end encrypted.
    if (message.type === 'system') return message;
    console.warn(
      `e2e: refusing an unencrypted DM message (${message.id}) — every DM is encrypted`
    );
    return { ...message, content: DECRYPT_FAILED_CONTENT };
  }
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
    // The socket echo can beat the POST response that writes the cache entry —
    // but that race only exists for a message sent moments ago. An OLD own
    // message with no cache entry (sent from another device) will never gain
    // one, and a history window can hold dozens of them: retrying 4×150ms per
    // message turns a search jump into a multi-second hang. One immediate
    // lookup for old messages; the patient retry only for fresh ones.
    const ageMs = Date.now() - new Date(message.createdAt).getTime();
    const attempts = Number.isFinite(ageMs) && ageMs < 10_000 ? 4 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempts > 1) await new Promise((r) => setTimeout(r, 150));
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
  // No `some(m => m.encrypted)` short-circuit: a page of forged plaintext rows
  // would satisfy it and bypass the per-message check entirely, which is
  // exactly the shape an attacker controls. Every row goes through the same
  // gate; the fast path for genuinely unencrypted system notices is inside it.
  if (messages.length === 0) return messages;
  // Sequential on purpose: decryption mutates ratchet state through a serial
  // queue anyway, and order here matches timeline order for skipped-key bookkeeping.
  const out: Message[] = [];
  for (const m of messages) {
    try {
      out.push(await decryptMessageForDisplay(m));
    } catch (err) {
      // One message whose decrypt PIPELINE fails (vault IO, engine state —
      // not mere bad ciphertext, which degrades inside) must not abort the
      // whole page into a "Failed to load messages" toast. Show the one
      // failure, keep the conversation.
      console.error(`e2e: decrypt pipeline failed for message ${m.id}:`, err);
      out.push({ ...m, content: DECRYPT_FAILED_CONTENT });
    }
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

/**
 * Resolve an encrypted conversation-list preview from the local cache.
 *
 * Parsed, never raw. The cache holds the plaintext as it was ENCRYPTED, and for
 * a message with an attachment that is a structured payload:
 * `{"v":1,"t":"here you go","a":[{s3Key,fileName,...,"key":"<AES-256 file key>","iv":...}]}`.
 * Returning it verbatim put the file's decryption key and its true filename
 * into the sidebar, the DOM, the accessibility tree and any screenshot. Every
 * other consumer of this cache parses (applyPlaintext, resolveReplyPreview,
 * searchDecrypted); this one did not, and nothing in the display layer is the
 * right place to notice.
 */
export async function resolveEncryptedPreview(messageId: string): Promise<string | null> {
  const userId = await currentUserId();
  if (!userId) return null;
  const raw = await getE2EService(userId).getCachedPlaintext(messageId);
  return raw === null ? null : parseE2EPlaintext(raw).text;
}
