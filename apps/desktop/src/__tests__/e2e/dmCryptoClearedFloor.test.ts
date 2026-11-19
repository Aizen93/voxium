import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildE2EPlaintext, buildMegolmEnvelope, DELETED_MESSAGE_TYPE } from '@voxium/shared';
import type { Message } from '@voxium/shared';

/**
 * The display gate and a cleared history (#47): from the moment the floor of
 * a conversation is known on this device, no row at or below it is shown,
 * counted, notified, cached or noted for a retry — a page or an event already
 * on its way when the removal landed included. The server serves none of
 * them after the removal; the gate catches what was in flight.
 */

const getCachedPlaintext = vi.fn();
const decryptMessage = vi.fn();

vi.mock('../../services/e2e/e2eService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/e2e/e2eService')>();
  return { ...actual, getE2EService: () => ({ getCachedPlaintext, decryptMessage }) };
});
vi.mock('../../stores/authStore', () => ({
  useAuthStore: { getState: () => ({ user: { id: 'me', username: 'me', displayName: 'Me', avatarUrl: null } }) },
}));
vi.mock('../../stores/serverStore', () => ({
  useServerStore: { getState: () => ({ members: [], secureChannelMembers: {} }) },
}));

const ledger = vi.hoisted(() => ({ noteUndecrypted: vi.fn() }));
vi.mock('../../services/e2e/undecryptedRows', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/e2e/undecryptedRows')>();
  return {
    ...actual,
    noteUndecrypted: (...args: Parameters<typeof actual.noteUndecrypted>) => {
      ledger.noteUndecrypted(...args);
      actual.noteUndecrypted(...args);
    },
  };
});

import { decryptMessageForDisplay, decryptMessagesForDisplay } from '../../services/e2e/dmCrypto';
import { registerE2ESessionUser } from '../../services/e2e/session';
import { raiseClearedFloor, resetClearedFloors } from '../../services/e2e/clearedFloors';
import { resetUndecryptedRows } from '../../services/e2e/undecryptedRows';

const FLOOR = '2026-11-10T10:00:00.000Z';
const FLOOR_MS = Date.parse(FLOOR);
const at = (offsetMs: number) => new Date(FLOOR_MS + offsetMs).toISOString();

function dmRow(over: Partial<Message> = {}): Message {
  return {
    id: 'm1',
    type: 'user',
    content: buildMegolmEnvelope('c2Vzc0lk', 'Y2lwaGVy'),
    channelId: null,
    conversationId: 'c1',
    encrypted: true,
    author: { id: 'peer', username: 'peer', displayName: 'Peer' },
    createdAt: at(1),
    editedAt: null,
    reactions: [],
    ...over,
  } as unknown as Message;
}

beforeEach(() => {
  registerE2ESessionUser(() => 'me');
  getCachedPlaintext.mockReset().mockResolvedValue(null);
  decryptMessage.mockReset().mockResolvedValue({ text: buildE2EPlaintext('hello') });
  ledger.noteUndecrypted.mockReset();
});

afterEach(() => {
  resetClearedFloors();
  resetUndecryptedRows();
  registerE2ESessionUser(null);
});

describe('one row (a socket event, a retry)', () => {
  it('a row at or below a known floor settles as nothing, before any cache read or decrypt (own rows too)', async () => {
    raiseClearedFloor('me', 'c1', FLOOR_MS);

    for (const row of [dmRow({ createdAt: FLOOR }), dmRow({ createdAt: at(-1) }), dmRow({ createdAt: FLOOR, author: { id: 'me' } as Message['author'] })]) {
      expect(await decryptMessageForDisplay(row)).toBeNull();
    }
    expect(decryptMessage).not.toHaveBeenCalled();
    expect(getCachedPlaintext).not.toHaveBeenCalled();
    expect(ledger.noteUndecrypted).not.toHaveBeenCalled();
  });

  it('one millisecond above the floor is shown as before', async () => {
    raiseClearedFloor('me', 'c1', FLOOR_MS);

    const shown = await decryptMessageForDisplay(dmRow({ createdAt: at(1) }));

    expect(shown?.content).toBe('hello');
  });

  it('the conversation it is shown in decides as well as the one the row names', async () => {
    raiseClearedFloor('me', 'c1', FLOOR_MS);

    expect(await decryptMessageForDisplay(dmRow({ conversationId: 'c2', createdAt: FLOOR }), { conversationId: 'c1' })).toBeNull();
    expect(await decryptMessageForDisplay(dmRow({ conversationId: 'c1', createdAt: FLOOR }), { conversationId: 'c2' })).toBeNull();
    expect(decryptMessage).not.toHaveBeenCalled();
  });

  it('a floor that lands while the row is decrypted: nothing is shown, a failure is not noted for a retry', async () => {
    decryptMessage.mockImplementationOnce(async () => {
      raiseClearedFloor('me', 'c1', FLOOR_MS);
      return { text: buildE2EPlaintext('hello') };
    });
    expect(await decryptMessageForDisplay(dmRow({ createdAt: FLOOR }))).toBeNull();

    resetClearedFloors();
    decryptMessage.mockImplementationOnce(async () => {
      raiseClearedFloor('me', 'c1', FLOOR_MS);
      return { text: '', failed: true };
    });
    expect(await decryptMessageForDisplay(dmRow({ id: 'm2', createdAt: FLOOR }))).toBeNull();
    expect(ledger.noteUndecrypted).not.toHaveBeenCalled();
  });

  it('a deleted account\'s row at or below the floor goes too; another account\'s floors decide nothing here', async () => {
    raiseClearedFloor('me', 'c1', FLOOR_MS);
    raiseClearedFloor('someone-else', 'c2', FLOOR_MS);

    expect(await decryptMessageForDisplay(dmRow({ type: DELETED_MESSAGE_TYPE, encrypted: false, content: '', createdAt: FLOOR }))).toBeNull();
    expect((await decryptMessageForDisplay(dmRow({ conversationId: 'c2', createdAt: FLOOR })))?.content).toBe('hello');
  });
});

describe('a page (fetched before the removal, answered after it)', () => {
  it('rows at or below the floor are left out unopened; the rest keep their order', async () => {
    raiseClearedFloor('me', 'c1', FLOOR_MS);

    const page = await decryptMessagesForDisplay(
      [dmRow({ id: 'a', createdAt: at(-5) }), dmRow({ id: 'b', createdAt: FLOOR }), dmRow({ id: 'c', createdAt: at(1) }), dmRow({ id: 'd', createdAt: at(2) })],
      { conversationId: 'c1' },
    );

    expect(page.map((m) => m.id)).toEqual(['c', 'd']);
    expect(decryptMessage).toHaveBeenCalledTimes(2);
  });

  it('a floor that lands while later rows are opened covers the rows already opened too', async () => {
    decryptMessage
      .mockResolvedValueOnce({ text: buildE2EPlaintext('first') })
      .mockImplementationOnce(async () => {
        raiseClearedFloor('me', 'c1', FLOOR_MS);
        return { text: buildE2EPlaintext('second') };
      })
      .mockResolvedValueOnce({ text: buildE2EPlaintext('third') });

    const page = await decryptMessagesForDisplay(
      [dmRow({ id: 'a', createdAt: at(-5) }), dmRow({ id: 'b', createdAt: FLOOR }), dmRow({ id: 'c', createdAt: at(1) })],
      { conversationId: 'c1' },
    );

    expect(page.map((m) => [m.id, m.content])).toEqual([['c', 'third']]);
  });

  it('with no floor the page is what it was', async () => {
    const page = await decryptMessagesForDisplay([dmRow({ id: 'a', createdAt: at(-5) }), dmRow({ id: 'b', createdAt: FLOOR })], { conversationId: 'c1' });
    expect(page.map((m) => m.id)).toEqual(['a', 'b']);
  });
});
