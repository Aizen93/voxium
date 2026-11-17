// Display-layer gate between DM stores/components and the E2E service.
// Encrypted messages are decrypted (or resolved from the local cache) before
// they reach any store or the DOM. An unencrypted row passes only when it is
// one of the server's own call notices (DM_SYSTEM_NOTICES); every other one is
// refused and shown as "unable to decrypt". The one other unencrypted shape is
// a deleted account's message (`type: 'deleted'`), which the gate builds itself
// from the row's id, conversation and time (deletedMessageRow), keeping
// nothing else the server sent. Whatever the server attaches that
// the crypto did not vouch for — `e2eAttachments`, plaintext `attachments` on
// a refused row, an unencrypted reply quote — is dropped here; the shapes
// (refusedRow, lockedQuote, withoutServerAssertions) live in displayGate.ts,
// shared with channelCrypto and the send path.
//
// NOTE: stores are imported DYNAMICALLY inside functions. resetStores.ts
// captures every account store's initial state at module-eval time, so a
// static store import from a service pulled in by chatStore would create an
// eval-order cycle that crashes at boot.
import { buildE2EPlaintext, parseE2EPlaintext, isDMSystemNotice, isDeletedParticipantId, DELETED_MESSAGE_TYPE } from '@voxium/shared';
import type { Message, E2EAttachmentMeta } from '@voxium/shared';
import { getE2EService, scopeMarkedPurged, E2EIdentityChangedError, READ_ONLY_PURGE_MARK, type E2EMessagePosition } from './e2eService';
import {
  DECRYPT_FAILED_CONTENT,
  decryptedRow,
  deletedMessageRow,
  deletedQuote,
  isDeletedQuote,
  lockedQuote,
  refusedRow,
  withoutServerAssertions,
} from './displayGate';
import { currentE2ESessionUser, isE2ESessionEnded } from './session';
import { arrivalMark, noteQuoteAwaiting, noteUndecrypted } from './undecryptedRows';
import { isParticipantDeleted, isHeldReadOnly, DMConversationReadOnlyError } from '../../utils/dmParticipant';

export { E2EIdentityChangedError, DECRYPT_FAILED_CONTENT };

async function currentUserId(): Promise<string | null> {
  const { useAuthStore } = await import('../../stores/authStore');
  return useAuthStore.getState().user?.id ?? null;
}

/**
 * dmStore, once its dynamic import has settled (a static import would close
 * an eval-order cycle with resetStores, see the note above). From then on
 * each read-only lookup is one synchronous read of the store's state, with no
 * promise (heldReadOnly answers a boolean). The gate looks before a row is
 * opened, when its quote is read, and once more as its last step.
 */
let dmStoreModule: typeof import('../../stores/dmStore') | null = null;

/** The DM store's word: whether it holds any of these read-only, and which of them no list has loaded. */
interface StoreWord {
  held: boolean;
  notLoaded: Array<string | null | undefined>;
}

function readOnlyIn(module: typeof import('../../stores/dmStore'), ids: Array<string | null | undefined>): StoreWord {
  const state = module.useDMStore.getState();
  return {
    held: ids.some((id) => isHeldReadOnly(state, id)),
    notLoaded: ids.filter((id) => !!id && !state.conversations.some((c) => c.id === id)),
  };
}

/** The DM store's word on these conversations: synchronous once dmStore is loaded, a promise only for the first lookup. */
function heldByStore(conversationIds: Array<string | null | undefined>): StoreWord | Promise<StoreWord> {
  if (dmStoreModule) return readOnlyIn(dmStoreModule, conversationIds);
  return import('../../stores/dmStore').then(
    (module) => {
      dmStoreModule = module;
      return readOnlyIn(module, conversationIds);
    },
    (err: unknown) => {
      console.warn('e2e: the read-only state of a conversation could not be read:', err instanceof Error ? err.message : err);
      return { held: false, notLoaded: conversationIds };
    },
  );
}

/**
 * Whether an earlier session recorded the purge of any of these conversations
 * (scopeMarkedPurged): a list confirmed it read-only then, so the mark holds
 * from the start of this session for a conversation no list of this session
 * has loaded yet. A boolean once the service has read its marks.
 */
function heldByMark(conversationIds: Array<string | null | undefined>): boolean | Promise<boolean> {
  const userId = currentE2ESessionUser();
  const pending: Promise<boolean>[] = [];
  for (const id of new Set(conversationIds)) {
    if (!id) continue;
    const marked = scopeMarkedPurged(userId, id);
    if (marked === true) return true;
    if (marked !== false) pending.push(marked);
  }
  if (pending.length === 0) return false;
  return Promise.all(pending).then((answers) => answers.some(Boolean));
}

/**
 * Whether any of these conversations is held read-only (the other side's
 * account was deleted: utils/dmParticipant.ts): by the DM store's word for a
 * conversation a list of this session loaded (its sticky read-only state and
 * the ids an event named included), whatever an earlier session's mark says;
 * by that purge mark only for one no list has loaded yet. A boolean once both
 * are loaded, a promise only until then. A failed lookup says nothing about
 * the conversation: logged, and the row is gated as before (the server
 * refuses what a read-only conversation does not allow).
 */
function heldReadOnly(...conversationIds: Array<string | null | undefined>): boolean | Promise<boolean> {
  const decide = ({ held, notLoaded }: StoreWord): boolean | Promise<boolean> =>
    held ? true : notLoaded.length > 0 ? heldByMark(notLoaded) : false;
  const byStore = heldByStore(conversationIds);
  return byStore instanceof Promise ? byStore.then(decide) : decide(byStore);
}

/** heldReadOnly, awaited only when it had to load dmStore. */
async function heldReadOnlyNow(...conversationIds: Array<string | null | undefined>): Promise<boolean> {
  const answer = heldReadOnly(...conversationIds);
  return typeof answer === 'boolean' ? answer : await answer;
}

/** One of the server's own call notices: the only plaintext a DM row may carry (DM_SYSTEM_NOTICES). */
function isListedNotice(row: { type?: string; encrypted?: boolean; content: string }): boolean {
  return row.type === 'system' && !row.encrypted && isDMSystemNotice(row.content);
}

/**
 * In a conversation held read-only, a quote that is neither this account's own
 * message nor a listed call notice stands for a deleted account's message: it
 * keeps no text, from the server or the cache, and waits for nothing.
 */
function quoteStandsAsDeleted(quote: NonNullable<Message['replyTo']>, userId: string | null): boolean {
  if (isDeletedQuote(quote)) return true;
  return quote.author?.id !== userId && !(!quote.encrypted && isDMSystemNotice(quote.content));
}

/**
 * A quote's text from the local cache: an entry of THIS conversation written
 * by the quoted author (the server names both the id and the author); null
 * when there is none.
 */
async function cachedQuoteText(scope: string, quote: NonNullable<Message['replyTo']>, userId: string): Promise<string | null> {
  const cached = await getE2EService(userId).getCachedPlaintext(quote.id, { scope, authorId: quote.author?.id });
  // cached entries hold raw plaintext — structured payloads carry the text field
  return cached ? parseE2EPlaintext(cached).text : null;
}

async function resolveReplyPreview(message: Message, userId: string, readOnly = false): Promise<Message> {
  if (!message.replyTo) return message;
  // a quote names its author; one without is malformed and is dropped whole
  if (!message.replyTo.author) return { ...message, replyTo: null };
  const scope = message.conversationId ?? '';
  // A deleted account's message, quoted (or, in a conversation held
  // read-only, any quote that is not our own or a call notice): no text at
  // all, from the server or the cache, and nothing to wait for (the UI says
  // "Message deleted")
  if (isDeletedQuote(message.replyTo) || (readOnly && quoteStandsAsDeleted(message.replyTo, userId))) {
    return scope ? { ...message, replyTo: deletedQuote(message.replyTo, scope) } : { ...message, replyTo: lockedQuote(message.replyTo) };
  }
  if (!message.replyTo.encrypted) {
    // An unencrypted quote is trusted only when it is one of the server's call
    // notices; anything else renders as the lock placeholder
    return isDMSystemNotice(message.replyTo.content)
      ? message
      : { ...message, replyTo: lockedQuote(message.replyTo) };
  }
  const text = await cachedQuoteText(scope, message.replyTo, userId);
  const replyTo = { ...message.replyTo, content: text ?? '' };
  // nothing yet: this very quote is looked up again once the quoted row opens here
  if (text === null && scope) noteQuoteAwaiting(replyTo, scope);
  return { ...message, replyTo };
}

/**
 * The text the quote of `message` shows from the local cache, by the rule its
 * gating followed (resolveReplyPreview): for a quote that found nothing when
 * its row was gated, once the quoted row opened on this device. Null while
 * the cache still has nothing, or when nobody is signed in.
 */
export async function quotedTextFromCache(message: Message): Promise<string | null> {
  if (!message.replyTo?.author || !message.conversationId) return null;
  const userId = await currentUserId();
  if (!userId) return null;
  // the read-only rule of resolveReplyPreview: no cache read for such a quote
  if ((await heldReadOnlyNow(message.conversationId)) && quoteStandsAsDeleted(message.replyTo, userId)) return null;
  return cachedQuoteText(message.conversationId, message.replyTo, userId);
}

/**
 * Decrypt one message for display. Megolm messages decrypt on every device of
 * both participants (including our own sends), so the normal path handles them.
 * Own echoes can still race the send path's cache write, and legacy olm1 own
 * messages are cache-only, so own messages fall back to retrying the cache.
 *
 * A decrypt the session's end overtook (logout, account switch) settles as
 * `null`: nothing about it may be shown, counted or notified, since the
 * screen and the stores belong to whoever signs in next. Its callers include
 * socket handlers that do not catch, so it never rejects for that.
 *
 * `retry: true` (a row tried again once its session was stored) never starts
 * a key-share claim, a session that is not on the device being a failure,
 * and rejects on a failure of the vault instead of answering the refused
 * shape: such a try says nothing about the message.
 */
export async function decryptMessageForDisplay(
  input: Message,
  opts: { retry?: boolean; conversationId?: string } = {},
): Promise<Message | null> {
  try {
    return await decryptOneForDisplay(input, opts.retry === true, opts.conversationId);
  } catch (err) {
    if (!isE2ESessionEnded(err)) throw err;
    console.debug(`e2e: decrypt of ${input.id} ended with the session:`, err instanceof Error ? err.message : err);
    return null;
  }
}

async function decryptOneForDisplay(input: Message, retry: boolean, pageConversationId?: string): Promise<Message> {
  // The conversation a row is shown in: the page's when a page was fetched
  // for one (the row's own id is the server's word), the row's own otherwise
  const shownIn = pageConversationId ?? input.conversationId ?? null;
  // A deleted account's message (the conversation outlived the account): its
  // own shape, every field set by the gate, before the refusal of unencrypted
  // rows and before anything reads the cache or notes the row. The type alone
  // decides: text or ciphertext a server put in such a row is never shown.
  if (input.type === DELETED_MESSAGE_TYPE) {
    if (!shownIn) return refusedRow(withoutServerAssertions(input));
    return deletedMessageRow(input, shownIn);
  }
  const message = withoutServerAssertions(input);
  // A conversation held read-only (the other side's account was deleted): a
  // row that is neither this account's own nor a listed call notice stands
  // for that account's message, whether or not the server has rewritten it
  // yet (a page or an event in flight when the conversation turned). The same
  // shape as a `deleted` row, decided before any decrypt, cache read or retry
  // note, so nothing of it is shown, counted, notified or cached. Every other
  // conversation is gated as it was; the lookup is one read of the store's
  // state (and of the service's purge marks) once both are loaded.
  const lookup = shownIn ? heldReadOnly(shownIn, message.conversationId) : false;
  // no await on the ordinary path once dmStore is loaded
  const readOnly = typeof lookup === 'boolean' ? lookup : await lookup;
  if (readOnly && !isListedNotice(message)) {
    const userId = await currentUserId();
    if (!userId || message.author?.id !== userId) return deletedMessageRow(input, shownIn!);
  }
  // a quote is judged by the flag as it stands when it is read (the
  // conversation may turn during the decrypt): no cache read for the quote of
  // a conversation that turned meanwhile
  const quoteFlag = async () => readOnly || (!!shownIn && (await heldReadOnlyNow(shownIn, message.conversationId)));
  const gated = await gateRow(message, retry, quoteFlag);
  // The flag again, as the LAST step of every path: the conversation may have
  // turned read-only during the decrypt, the cache reads or the quote's lookup
  return settleReadOnly(input, message, shownIn, gated);
}

/**
 * What gateRow decided: the row, the account it was gated for (null on the
 * paths that read none), whether a decrypt ran for it (which may have written
 * a cache entry), and the retry note it owes (taken only if the row stands).
 */
interface GatedRow {
  row: Message;
  userId: string | null;
  decrypted: boolean;
  noteRetry: (() => void) | null;
}

/**
 * The last step of the gate: is the conversation held read-only NOW? Then a
 * row that is not this account's own (nor a listed call notice) comes back as
 * the deleted shape on every path, the refused one included, with no retry
 * note, and the cache entry a decrypt may have written for it is dropped
 * (only when the row is of the conversation it is shown in: a row naming
 * another conversation's id costs that conversation nothing). An own row
 * keeps its text, and its quote is judged again under the fresh flag (one the
 * conversation turned under while its cache read ran).
 */
async function settleReadOnly(
  input: Message,
  message: Message,
  shownIn: string | null,
  { row, userId, decrypted, noteRetry }: GatedRow,
): Promise<Message> {
  if (!shownIn || isListedNotice(message) || !(await heldReadOnlyNow(shownIn, message.conversationId))) {
    noteRetry?.();
    return row;
  }
  const accountId = userId ?? (await currentUserId());
  const own = !!accountId && message.author?.id === accountId;
  if (!own) {
    if (decrypted && userId && message.conversationId === shownIn) {
      try {
        await getE2EService(userId).forgetCachedPlaintext(
          message.id,
          { scope: shownIn, authorId: message.author?.id ?? '' },
          { mark: READ_ONLY_PURGE_MARK },
        );
      } catch (err) {
        if (isE2ESessionEnded(err)) throw err;
        console.warn(`e2e: the cache entry of message ${message.id} could not be dropped:`, err instanceof Error ? err.message : err);
      }
    }
    return deletedMessageRow(input, shownIn);
  }
  noteRetry?.();
  // our own row: a quote that is not ours (nor a call notice) keeps no text now
  if (row.replyTo?.author && !isDeletedQuote(row.replyTo) && quoteStandsAsDeleted(row.replyTo, accountId)) {
    return { ...row, replyTo: deletedQuote(row.replyTo, shownIn) };
  }
  return row;
}

/** The gate past its first checks: the unencrypted rule, the decrypt, the own-message cache, the refused shape. */
async function gateRow(message: Message, retry: boolean, quoteFlag: () => Promise<boolean>): Promise<GatedRow> {
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
    //
    // The `type` field is the server's word too, so a "system" row is trusted
    // only when its text is one of the notices the server actually writes.
    if (message.type === 'system' && isDMSystemNotice(message.content)) {
      return { row: { ...message, attachments: [], replyTo: null }, userId: null, decrypted: false, noteRetry: null };
    }
    console.warn(
      `e2e: refusing an unencrypted DM message (${message.id}) — every DM is encrypted`
    );
    return { row: refusedRow(message), userId: null, decrypted: false, noteRetry: null };
  }
  // A DM row belongs to a conversation; one without is nothing the crypto can
  // scope a decrypt, or a cache read, to
  if (!message.conversationId) return { row: refusedRow(message), userId: null, decrypted: false, noteRetry: null };
  const conversationId = message.conversationId;
  const userId = await currentUserId();
  if (!userId) return { row: refusedRow(message), userId: null, decrypted: false, noteRetry: null };
  // An encrypted row under the deleted account's placeholder: no session
  // speaks for that id and none ever will, so nothing is decrypted, claimed
  // or noted for a later try
  if (isDeletedParticipantId(message.author?.id)) {
    return { row: await resolveReplyPreview(refusedRow(message), userId, await quoteFlag()), userId, decrypted: false, noteRetry: null };
  }

  const service = getE2EService(userId);
  const own = message.author?.id === userId;

  // before the decrypt: a session stored while it runs makes this row due too
  const mark = arrivalMark();
  const result = await service.decryptMessage(
    {
      id: message.id,
      conversationId,
      authorId: message.author?.id ?? '',
      content: message.content,
      editedAt: message.editedAt ?? null,
      createdAt: message.createdAt,
    },
    { claimMissing: !retry, storageFailureRejects: retry },
  );
  if (!result.failed) {
    return { row: await resolveReplyPreview(decryptedRow(message, result.text), userId, await quoteFlag()), userId, decrypted: true, noteRetry: null };
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
      // version-checked: an edit echo must not serve the pre-edit cache entry;
      // and only our OWN entry of this conversation answers for "own"
      const cached = await service.getCachedPlaintext(message.id, {
        scope: conversationId,
        authorId: userId,
        editedAt: message.editedAt ?? null,
      });
      if (cached !== null) {
        return { row: await resolveReplyPreview(decryptedRow(message, cached), userId, await quoteFlag()), userId, decrypted: true, noteRetry: null };
      }
    }
  }
  // Nothing vouched for this row: the refused shape, its quote still resolvable
  // from the local cache. The failure is noted for this version, so that its
  // group session reaching this device later opens the row in place once the
  // view shows it (redecryptOnKeyArrival.ts): noted by settleReadOnly, and
  // only when the row stands as refused
  const refused = await resolveReplyPreview(refusedRow(message), userId, await quoteFlag());
  return { row: refused, userId, decrypted: true, noteRetry: () => noteUndecrypted(message, conversationId, mark) };
}

/**
 * Decrypt a fetched page of messages (order preserved). Only the server's call
 * notices pass unencrypted, beside the deleted-message rows the gate builds.
 */
export async function decryptMessagesForDisplay(messages: Message[], opts: { conversationId?: string } = {}): Promise<Message[]> {
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
      // a row the session's end overtook keeps the page's shape as a refused row
      out.push((await decryptMessageForDisplay(m, { conversationId: opts.conversationId })) ?? refusedRow(withoutServerAssertions(m)));
    } catch (err) {
      // One message whose decrypt PIPELINE fails (vault IO, engine state —
      // not mere bad ciphertext, which degrades inside) must not abort the
      // whole page into a "Failed to load messages" toast. Show the one
      // failure, keep the conversation.
      console.error(`e2e: decrypt pipeline failed for message ${m.id}:`, err);
      out.push(refusedRow(m));
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
): Promise<{ content: string; plaintext: string; position: E2EMessagePosition }> {
  const { useDMStore } = await import('../../stores/dmStore');
  const conversation = useDMStore.getState().conversations.find((c) => c.id === conversationId);
  // The peer id drives the session fanout, so a conversation the store has not
  // loaded cannot be encrypted to anyone — and must not degrade to a plaintext
  // send the server would reject anyway (plan §4.2).
  if (!conversation) throw new Error(`Conversation ${conversationId} is not loaded`);
  // the other side's account is gone: nothing is encrypted to its placeholder
  if (isParticipantDeleted(conversation)) throw new DMConversationReadOnlyError(conversationId);

  const userId = await currentUserId();
  if (!userId) throw new Error('Not authenticated');

  const plaintext = buildE2EPlaintext(text, attachments);
  try {
    // group session per conversation — the peer id drives the share fanout
    const { envelope, position } = await getE2EService(userId).encryptMessage(
      conversationId,
      conversation.participant.id,
      plaintext
    );
    return { content: envelope, plaintext, position };
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
 * bind the ratchet `position` it was encrypted at (prepareOutgoingDM) to them —
 * the only place an own message's position is ever bound.
 */
export async function cacheSentPlaintext(
  messageId: string,
  conversationId: string,
  plaintext: string,
  editedAt?: string | null,
  createdAt?: string,
  position?: E2EMessagePosition
): Promise<void> {
  const userId = await currentUserId();
  if (!userId) return;
  await getE2EService(userId).cachePlaintext(messageId, conversationId, plaintext, editedAt, {
    authorId: userId,
    ...(createdAt && { createdAt }),
    ...(position && { position }),
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

  // The other side's account was deleted: only this account's own lines are
  // found there, whatever the cache still holds before (or after a failed)
  // purge of that conversation (services/dmReadOnly.ts)
  const ownOnly = isParticipantDeleted(conversation) || (await heldReadOnlyNow(conversationId));
  const hits = (await getE2EService(userId).searchDecrypted(conversationId, query))
    // pre-Phase-C cache entries lack createdAt — they can't be rendered or
    // jumped to reliably, so they're excluded rather than shown broken
    .filter((hit) => hit.createdAt)
    .filter((hit) => !ownOnly || hit.authorId === userId);
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
export async function resolveEncryptedPreview(
  messageId: string,
  conversationId: string,
  authorId?: string,
): Promise<string | null> {
  const userId = await currentUserId();
  if (!userId) return null;
  // held read-only: only this account's own last message has a preview from
  // the cache; the other person's stands as deleted (no cache read)
  if (authorId !== userId && (await heldReadOnlyNow(conversationId))) return null;
  const raw = await getE2EService(userId).getCachedPlaintext(messageId, { scope: conversationId, authorId });
  return raw === null ? null : parseE2EPlaintext(raw).text;
}
