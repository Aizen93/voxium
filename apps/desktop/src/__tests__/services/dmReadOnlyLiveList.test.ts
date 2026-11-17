import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildMegolmEnvelope, DELETED_MESSAGE_TYPE } from '@voxium/shared';
import type { Conversation, Message } from '@voxium/shared';

/**
 * The device follows the conversation list both ways. A purge mark an earlier
 * session wrote holds a conversation read-only in the display gate from the
 * start of a session; a list that serves it live clears that mark, in the
 * vault and in memory, and the conversation is gated as live again. A list
 * that does not name it keeps the mark; one that confirms it again writes
 * nothing and walks nothing. The real E2E service and vault (fake IndexedDB),
 * the real dmStore, dmReadOnly and display gate; only the decrypt itself is
 * stubbed (no Megolm session here).
 */

const h = vi.hoisted(() => ({
  apiGet: vi.fn(),
  auth: { user: { id: 'me' } as { id: string } | null },
  chat: { clearMessages: vi.fn(), fetchDMMessages: vi.fn(async () => {}) },
  e2e: { ready: true, error: null as string | null, listeners: [] as Array<(s: { ready: boolean; error: string | null }) => void> },
}));

vi.mock('../../services/api', () => ({ api: { get: h.apiGet, post: vi.fn(), patch: vi.fn(), delete: vi.fn(), put: vi.fn() } }));
vi.mock('../../stores/toastStore', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));
vi.mock('../../stores/authStore', () => ({ useAuthStore: { getState: () => h.auth } }));
vi.mock('../../stores/chatStore', () => ({ useChatStore: { getState: () => h.chat } }));
vi.mock('../../stores/serverStore', () => ({ useServerStore: { getState: () => ({ activeServerId: null, members: [], secureChannelMembers: {} }) } }));
vi.mock('../../stores/voiceStore', () => ({
  useVoiceStore: { getState: () => ({ dmCallConversationId: null, incomingCall: null, handleDMCallEnded: vi.fn(), setIncomingCall: vi.fn() }) },
}));
vi.mock('../../stores/e2eStore', () => ({
  useE2EStore: {
    getState: () => ({ ready: h.e2e.ready, error: h.e2e.error }),
    subscribe: (cb: (s: { ready: boolean; error: string | null }) => void) => {
      h.e2e.listeners.push(cb);
      return () => { h.e2e.listeners = h.e2e.listeners.filter((l) => l !== cb); };
    },
  },
}));

import { getE2EService, disposeE2EService, type E2EService } from '../../services/e2e/e2eService';
import { E2EVault } from '../../services/e2e/vault';
import { registerE2ESessionUser } from '../../services/e2e/session';
import { decryptMessageForDisplay } from '../../services/e2e/dmCrypto';
import { useDMStore } from '../../stores/dmStore';

const PEER = { id: 'u-alice', username: 'alice', displayName: 'Alice', avatarUrl: null };
let n = 0;

function conv(id: string, over: Partial<Conversation> = {}): Conversation {
  return {
    id, user1Id: h.auth.user!.id, user2Id: 'u-alice', participant: { ...PEER }, lastMessage: null,
    encryptedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z', ...over,
  };
}
function servedReadOnly(id: string): Conversation {
  return conv(id, { user2Id: null, participant: { id: `deleted:${id}`, username: 'deleted', displayName: 'Deleted user', avatarUrl: null }, participantDeleted: true });
}
/** The other person's row, pushed over the socket before or after a list. */
function pushed(): Message {
  return {
    id: 'm-push', type: 'user', content: buildMegolmEnvelope('c2Vzc0lk', 'Y2lwaGVy'), encrypted: true,
    channelId: null, conversationId: 'c1', author: { ...PEER }, mentions: [], attachments: [], reactions: [],
    createdAt: '2026-11-01T10:00:00.000Z', editedAt: null,
  };
}

/** The dynamic imports and promise chains a list fetch starts. No timer. */
async function settle() {
  for (let round = 0; round < 5; round++) {
    await vi.dynamicImportSettled();
    for (let i = 0; i < 10; i++) await Promise.resolve();
  }
}

const vaultOf = (service: E2EService) => (service as unknown as { vault: E2EVault }).vault;

let service: E2EService;

beforeEach(async () => {
  h.e2e.ready = true;
  h.e2e.error = null;
  h.e2e.listeners = [];
  h.auth.user = { id: `me-${++n}` };
  registerE2ESessionUser(() => h.auth.user?.id ?? null);
  useDMStore.setState({ conversations: [], readOnlyPurges: {}, readOnlyConfirmed: {}, readOnlyPending: {}, activeConversationId: null });
  service = getE2EService(h.auth.user.id);
  // an earlier session's purge of c1, confirmed by its list
  await service.purgeCachedPlaintexts(['c1'], () => false, { mark: 'read-only' });
  vi.spyOn(service, 'decryptMessage').mockResolvedValue({ text: 'their words', failed: false });
});

afterEach(() => {
  vi.restoreAllMocks();
  disposeE2EService();
  registerE2ESessionUser(null);
});

describe('a marked conversation and the list', () => {
  it('before any list, the gate holds it read-only; a list serving it live clears the mark and the row is shown as an ordinary message', async () => {
    const before = await decryptMessageForDisplay(pushed());
    expect(before!.type).toBe(DELETED_MESSAGE_TYPE);
    expect(service.decryptMessage).not.toHaveBeenCalled();

    h.apiGet.mockResolvedValue({ data: { data: [conv('c1')] } });
    await useDMStore.getState().fetchConversations();
    await settle();
    // in memory at once, in the vault through the queue
    expect(service.scopePurged('read-only', 'c1')).toBe(false);
    await vi.waitFor(async () => expect(await vaultOf(service).listPurgedScopes('read-only')).toEqual([]));

    const after = await decryptMessageForDisplay(pushed());
    expect(after).toMatchObject({ id: 'm-push', type: 'user', content: 'their words', encrypted: true, conversationId: 'c1' });
    expect(after!.author.id).toBe('u-alice');
    expect(useDMStore.getState().conversations[0].participantDeleted).toBeUndefined();
  });

  it('a list serving it live is believed at once, before the mark is cleared (the E2E start still pending): the row, the preview, the retry', async () => {
    await service.cachePlaintext('m-last', 'c1', 'their last words', null, { authorId: 'u-alice' });
    expect(await service.scopePurged('read-only', 'c1')).toBe(true);
    // the first list of a session usually lands before the E2E start ends: the clear waits for it
    h.e2e.ready = false;
    h.apiGet.mockResolvedValue({ data: { data: [conv('c1', {
      lastMessage: { id: 'm-last', content: 'ignored', encrypted: true, type: 'user', createdAt: '2026-11-01T10:00:00.000Z', authorId: 'u-alice' },
    })] } });
    await useDMStore.getState().fetchConversations();
    await settle();

    // the mark is still there, in memory and in the vault
    expect(service.scopePurged('read-only', 'c1')).toBe(true);
    expect(await vaultOf(service).listPurgedScopes('read-only')).toEqual(['c1']);
    // the preview hydration of that list resolved
    await vi.waitFor(() => expect(useDMStore.getState().conversations[0].lastMessage?.content).toBe('their last words'));
    // a pushed row of the other person is an ordinary message, counted and notified as one
    const shown = await decryptMessageForDisplay(pushed());
    expect(shown).toMatchObject({ id: 'm-push', type: 'user', content: 'their words', encrypted: true });
    expect(service.decryptMessage).toHaveBeenCalledTimes(1);

    // the start ends: the clear lands, so the next session starts right
    h.e2e.ready = true;
    for (const l of [...h.e2e.listeners]) l({ ready: true, error: null });
    await settle();
    await vi.waitFor(async () => expect(await vaultOf(service).listPurgedScopes('read-only')).toEqual([]));
    expect(service.scopePurged('read-only', 'c1')).toBe(false);
  });

  it('a list that does not name it clears nothing', async () => {
    h.apiGet.mockResolvedValue({ data: { data: [conv('c2')] } });
    await useDMStore.getState().fetchConversations();
    await settle();
    expect(await service.scopePurged('read-only', 'c1')).toBe(true);
    expect(await vaultOf(service).listPurgedScopes('read-only')).toEqual(['c1']);
    expect((await decryptMessageForDisplay(pushed()))!.type).toBe(DELETED_MESSAGE_TYPE);
  });

  it('a list that confirms it again writes nothing new and walks nothing', async () => {
    const batch = vi.spyOn(E2EVault.prototype, 'purgePlaintextBatch');
    const put = vi.spyOn(E2EVault.prototype, 'putScopesPurged');
    h.apiGet.mockResolvedValue({ data: { data: [servedReadOnly('c1')] } });
    await useDMStore.getState().fetchConversations();
    await settle();
    await vi.waitFor(() => expect(useDMStore.getState().readOnlyPurges).toEqual({ c1: 'done' }));
    expect(batch).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(await vaultOf(service).listPurgedScopes('read-only')).toEqual(['c1']);
  });
});
