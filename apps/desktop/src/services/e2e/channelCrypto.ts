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
import { getE2EService, E2EIdentityChangedError, type E2EMessagePosition } from './e2eService';
import { DECRYPT_FAILED_CONTENT, decryptedRow, lockedQuote, refusedRow, withoutServerAssertions } from './displayGate';
import { isE2ESessionEnded } from './session';
import { arrivalMark, noteQuoteAwaiting, noteUndecrypted } from './undecryptedRows';

export { E2EIdentityChangedError, DECRYPT_FAILED_CONTENT };

/** Split raw decrypted plaintext into display fields on a message. */

async function currentUserId(): Promise<string | null> {
  const { useAuthStore } = await import('../../stores/authStore');
  return useAuthStore.getState().user?.id ?? null;
}

/** A quote's text from the local cache: an entry of THIS channel written by the quoted author; null when there is none. */
async function cachedQuoteText(scope: string, quote: NonNullable<Message['replyTo']>, userId: string): Promise<string | null> {
  const cached = await getE2EService(userId).getCachedPlaintext(quote.id, { scope, authorId: quote.author?.id });
  return cached ? parseE2EPlaintext(cached).text : null;
}

async function resolveReplyPreview(message: Message, userId: string): Promise<Message> {
  if (!message.replyTo) return message;
  // a quote names its author; one without is malformed and is dropped whole
  if (!message.replyTo.author) return { ...message, replyTo: null };
  // Every secure-channel message is encrypted: an unencrypted quote is the
  // server's word and renders as the lock placeholder
  if (!message.replyTo.encrypted) return { ...message, replyTo: lockedQuote(message.replyTo) };
  const scope = message.channelId ? e2eChannelScope(message.channelId) : '';
  const text = await cachedQuoteText(scope, message.replyTo, userId);
  // nothing yet: this quote is looked up again once the quoted row opens here
  if (text === null && scope) noteQuoteAwaiting(scope, message.replyTo.id, message.id, message.replyTo.author.id);
  return { ...message, replyTo: { ...message.replyTo, content: text ?? '' } };
}

/**
 * The text the quote of `message` shows from the local cache, by the rule its
 * gating followed (resolveReplyPreview), once the quoted row opened on this
 * device. Null while the cache still has nothing, or when nobody is signed in.
 */
export async function quotedChannelTextFromCache(message: Message): Promise<string | null> {
  if (!message.replyTo?.author || !message.channelId) return null;
  const userId = await currentUserId();
  if (!userId) return null;
  return cachedQuoteText(e2eChannelScope(message.channelId), message.replyTo, userId);
}

/**
 * Decrypt one secure-channel message for display.
 *
 * The `encrypted: false` refusal mirrors dmCrypto: a secure channel has no
 * plaintext user-message path, so an unencrypted `type: 'user'` row can only
 * be a server-side forgery — honouring it would put words under a member's
 * name with no decrypt-failure marker. The flag is the server's word; it does
 * not get to decide whether a message was end-to-end encrypted.
 *
 * A decrypt the session's end overtook settles as `null`, as in dmCrypto:
 * nothing of it may reach the next session's screen, and socket handlers
 * await this without a catch.
 *
 * `retry: true` never starts a key-share claim and rejects on a failure of
 * the vault (see dmCrypto).
 */
export async function decryptChannelMessageForDisplay(
  input: Message,
  opts: { retry?: boolean } = {},
): Promise<Message | null> {
  try {
    return await decryptChannelOneForDisplay(input, opts.retry === true);
  } catch (err) {
    if (!isE2ESessionEnded(err)) throw err;
    console.debug(`e2e: decrypt of ${input.id} ended with the session:`, err instanceof Error ? err.message : err);
    return null;
  }
}

async function decryptChannelOneForDisplay(input: Message, retry: boolean): Promise<Message> {
  // e2eAttachments come out of the decrypted payload only, and mentions are
  // never resolved for encrypted rows (see dmCrypto)
  const message = withoutServerAssertions(input);
  if (!message.encrypted) {
    // Secure channels have no server notices at all: every unencrypted row is
    // refused, `type: 'system'` included (the type is the server's word)
    console.warn(
      `e2e: refusing an unencrypted message (${message.id}) in a secure channel`
    );
    return refusedRow(message);
  }
  if (!message.channelId) return refusedRow(message);
  const userId = await currentUserId();
  if (!userId) return refusedRow(message);

  const service = getE2EService(userId);
  const scope = e2eChannelScope(message.channelId);
  const own = message.author?.id === userId;

  // before the decrypt: a session stored while it runs makes this row due too
  const mark = arrivalMark();
  const result = await service.decryptMessage(
    {
      id: message.id,
      conversationId: scope,
      authorId: message.author?.id ?? '',
      content: message.content,
      editedAt: message.editedAt ?? null,
      createdAt: message.createdAt,
    },
    { claimMissing: !retry, storageFailureRejects: retry },
  );
  if (!result.failed) {
    return resolveReplyPreview(decryptedRow(message,result.text), userId);
  }

  if (own) {
    // Same race as DMs: the socket echo can beat the POST response that
    // writes the sender's cache entry. Patient retry only for fresh messages.
    const ageMs = Date.now() - new Date(message.createdAt).getTime();
    const attempts = Number.isFinite(ageMs) && ageMs < 10_000 ? 4 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempts > 1) await new Promise((r) => setTimeout(r, 150));
      const cached = await service.getCachedPlaintext(message.id, { scope, authorId: userId, editedAt: message.editedAt ?? null });
      if (cached !== null) {
        return resolveReplyPreview(decryptedRow(message,cached), userId);
      }
    }
  }
  // Nothing vouched for this row: the refused shape, its quote still resolvable
  // from the local cache. The failure is noted for this version, so that its
  // group session reaching this device later opens the row in place once the
  // view shows it (redecryptOnKeyArrival.ts)
  const refused = await resolveReplyPreview(refusedRow(message), userId);
  noteUndecrypted(message, scope, mark);
  return refused;
}

/** Decrypt a fetched page of secure-channel messages (order preserved). */
export async function decryptChannelMessagesForDisplay(messages: Message[]): Promise<Message[]> {
  // No short-circuit on `some(m => m.encrypted)` — same forged-plaintext-page
  // reasoning as dmCrypto.decryptMessagesForDisplay.
  if (messages.length === 0) return messages;
  const out: Message[] = [];
  for (const m of messages) {
    try {
      // a row the session's end overtook keeps the page's shape as a refused row
      out.push((await decryptChannelMessageForDisplay(m)) ?? refusedRow(withoutServerAssertions(m)));
    } catch (err) {
      console.error(`e2e: decrypt pipeline failed for message ${m.id}:`, err);
      out.push(refusedRow(m));
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
): Promise<{ content: string; plaintext: string; position: E2EMessagePosition; notReadyUserIds: string[] }> {
  const userId = await currentUserId();
  if (!userId) throw new Error('Not authenticated');

  const plaintext = buildE2EPlaintext(text, attachments);
  try {
    const { envelope, position, notReadyUserIds } = await getE2EService(userId).encryptChannelMessage(
      channelId,
      plaintext
    );
    return { content: envelope, plaintext, position, notReadyUserIds };
  } catch (err) {
    if (err instanceof E2EIdentityChangedError) {
      const { useE2EStore } = await import('../../stores/e2eStore');
      useE2EStore.getState().flagIdentityChanged(err.peerUserId);
    }
    throw err;
  }
}

/**
 * Store the sent plaintext under the server-assigned message id + version, and
 * bind its ratchet `position` (prepareOutgoingChannelMessage) to them — see
 * cacheSentPlaintext.
 */
export async function cacheSentChannelPlaintext(
  messageId: string,
  channelId: string,
  plaintext: string,
  editedAt?: string | null,
  createdAt?: string,
  position?: E2EMessagePosition
): Promise<void> {
  const userId = await currentUserId();
  if (!userId) return;
  await getE2EService(userId).cachePlaintext(messageId, e2eChannelScope(channelId), plaintext, editedAt, {
    authorId: userId,
    ...(createdAt && { createdAt }),
    ...(position && { position }),
  });
}

/**
 * Client-side search of a secure channel: the server is structurally blind to
 * ciphertext, so results come from this device's plaintext cache. Authors are
 * resolved from the channel's own member list first (it names everyone in
 * the channel), then from the server's known rows — on a big server those
 * are only the People panel's slice plus what was looked up.
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
  const { members, secureChannelMembers } = useServerStore.getState();
  const channelMembers = secureChannelMembers[channelId] ?? [];

  const hits = (await getE2EService(userId).searchDecrypted(e2eChannelScope(channelId), query))
    .filter((hit) => hit.createdAt);
  return hits.map((hit) => {
    const member = hit.authorId
      ? channelMembers.find((m) => m.userId === hit.authorId) ?? members.find((m) => m.userId === hit.authorId)
      : undefined;
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
