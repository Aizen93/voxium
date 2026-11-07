import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Message } from '@voxium/shared';

/**
 * chatStore decides "is this channel secure" through utils/secureChannelGate:
 * the loaded channel list OR this device's pin. A server that lists a pinned
 * channel as plaintext must not move the send path onto the plaintext branch
 * (the next message would leave the device in the clear) nor the fetch path
 * off the decrypt gate.
 */

const { apiPost, apiGet, channels } = vi.hoisted(() => ({
  apiPost: vi.fn(),
  apiGet: vi.fn(),
  channels: [] as { id: string; secure: boolean }[],
}));
vi.mock('../../services/api', () => ({ api: { post: apiPost, get: apiGet, patch: vi.fn(), delete: vi.fn() } }));
vi.mock('../../services/socket', () => ({ getSocket: () => null }));
vi.mock('../../stores/toastStore', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock('../../i18n', () => ({ default: { t: (k: string) => k } }));
vi.mock('../../stores/dmStore', () => ({ useDMStore: { getState: () => ({ updateLastMessage: vi.fn(), conversations: [] }) } }));
vi.mock('../../stores/serverStore', () => ({
  useServerStore: { getState: () => ({ channels, members: [], secureChannelMembers: {} }) },
}));
vi.mock('../../services/e2e/channelCrypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/e2e/channelCrypto')>();
  return {
    ...actual,
    prepareOutgoingChannelMessage: vi.fn(async () => ({
      content: '{"v":1,"e":"megolm1","sid":"s","b":"b"}', plaintext: 'raw', position: { sessionId: 's', messageIndex: 0 }, notReadyUserIds: [],
    })),
    cacheSentChannelPlaintext: vi.fn(async () => undefined),
    decryptChannelMessagesForDisplay: vi.fn(async (rows: Message[]) => rows.map((r) => ({ ...r, content: 'GATED' }))),
  };
});

import { useChatStore } from '../../stores/chatStore';
import { prepareOutgoingChannelMessage, decryptChannelMessagesForDisplay } from '../../services/e2e/channelCrypto';
import { activateSecurePins, deactivateSecurePins, forgetSecurePins, pinSecure } from '../../utils/securePins';

const me = { id: 'me', username: 'me', displayName: 'Me' };
const sentRow = { id: 'sent-1', type: 'user', content: 'cipher', encrypted: true, author: me, createdAt: '2026-10-17T10:00:00.000Z', editedAt: null, reactions: [], replyTo: null } as unknown as Message;

beforeEach(() => {
  apiPost.mockReset();
  apiGet.mockReset();
  vi.mocked(prepareOutgoingChannelMessage).mockClear();
  vi.mocked(decryptChannelMessagesForDisplay).mockClear();
  channels.length = 0;
  useChatStore.setState({ messages: [], replyingTo: null });
  forgetSecurePins('me');
  activateSecurePins('me');
});

afterEach(() => {
  deactivateSecurePins();
});

describe('chatStore honours the secure-channel pin', () => {
  it('a pinned channel the server now lists as plaintext still sends encrypted', async () => {
    channels.push({ id: 'ch1', secure: false });
    pinSecure('ch1');
    apiPost.mockResolvedValue({ data: { data: sentRow } });

    await useChatStore.getState().sendMessage('ch1', 'hello');

    expect(prepareOutgoingChannelMessage).toHaveBeenCalledWith('ch1', 'hello', undefined);
    expect(apiPost.mock.calls[0][1]).toMatchObject({ encrypted: true });
    expect(apiPost.mock.calls[0][1].content).not.toBe('hello');
    expect(useChatStore.getState().messages[0]).toMatchObject({ id: 'sent-1', content: 'hello', encrypted: true });
  });

  it('a pinned channel the server now lists as plaintext still fetches through the decrypt gate', async () => {
    channels.push({ id: 'ch1', secure: false });
    pinSecure('ch1');
    apiGet.mockResolvedValue({ data: { data: [{ ...sentRow, channelId: 'ch1', encrypted: false, content: 'forged plaintext' }], hasMore: false } });

    await useChatStore.getState().fetchMessages('ch1');

    expect(decryptChannelMessagesForDisplay).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().messages[0].content).toBe('GATED');
  });

  it('an unpinned plaintext channel keeps the plaintext paths (the pin only ever adds)', async () => {
    channels.push({ id: 'plain', secure: false });
    apiPost.mockResolvedValue({ data: { data: { ...sentRow, encrypted: false, content: 'hello' } } });

    await useChatStore.getState().sendMessage('plain', 'hello');

    expect(prepareOutgoingChannelMessage).not.toHaveBeenCalled();
    expect(apiPost.mock.calls[0][1]).toMatchObject({ content: 'hello' });
  });
});
