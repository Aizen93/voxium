import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Channel, MessageAuthor, SearchResult } from '@voxium/shared';

/**
 * Search results: a webhook picks its own name on every post, so a hit
 * authored by a webhook named "Alice" must carry the APP tag the message
 * header shows — the bare name would pass for the member. A local
 * (decrypted) hit, from a DM or a secure channel, is never a webhook's,
 * whatever the row claims.
 */

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t: (k: string) => k }) };
});

vi.mock('../../services/api', () => ({ api: { get: vi.fn() } }));
vi.mock('../../stores/chatStore', () => ({ useChatStore: { getState: () => ({ fetchMessagesAround: vi.fn(), fetchDMMessagesAround: vi.fn() }) } }));
vi.mock('../../stores/serverStore', () => ({ useServerStore: { getState: () => ({ activeChannelId: 'ch-1', setActiveChannel: vi.fn() }) } }));
vi.mock('../../stores/dmStore', () => ({ useDMStore: { getState: () => ({ activeConversationId: null, setActiveConversation: vi.fn() }) } }));
vi.mock('../../components/common/Avatar', () => ({ Avatar: () => <span data-testid="avatar" /> }));

const { localDM, localChannel } = vi.hoisted(() => ({ localDM: vi.fn(), localChannel: vi.fn() }));
vi.mock('../../services/e2e/dmCrypto', () => ({ searchEncryptedHistory: localDM }));
vi.mock('../../services/e2e/channelCrypto', () => ({ searchEncryptedChannelHistory: localChannel }));

import { api } from '../../services/api';
import { SearchModal } from '../../components/search/SearchModal';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockGet = api.get as unknown as Mock;

const channel = (id: string, name: string, extra: Partial<Channel> = {}): Channel => ({
  id, name, type: 'text', serverId: 'srv-1', categoryId: null, position: 0, createdAt: '2026-01-01T00:00:00.000Z', ...extra,
});
const CHANNELS = [channel('ch-1', 'general'), channel('ch-sec', 'vault', { secure: true })];

const alice: MessageAuthor = { id: 'u-alice', username: 'alice', displayName: 'Alice', avatarUrl: null };
const hookAlice: MessageAuthor = { id: 'webhook:wh-1', username: 'Alice', displayName: 'Alice', avatarUrl: null, isWebhook: true };

const hit = (id: string, author: MessageAuthor, extra: Partial<SearchResult> = {}): SearchResult => ({
  id, content: `deploy ${id}`, channelId: 'ch-1', author, createdAt: '2026-10-18T10:00:00.000Z', editedAt: null, channelName: 'general', ...extra,
});

let container: HTMLDivElement;
let root: Root;

async function render(props: { serverId?: string; conversationId?: string } = { serverId: 'srv-1' }) {
  await act(async () => {
    root.render(<SearchModal onClose={() => {}} channels={props.serverId ? CHANNELS : undefined} {...props} />);
  });
}

async function search(text: string) {
  const input = container.querySelector('input') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  // the 300 ms debounce, then the answer
  await act(async () => { await new Promise((r) => setTimeout(r, 350)); });
  for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
}

/** Each result row: [name shown, has an APP tag right after it]. */
const rows = () => [...container.querySelectorAll('[data-testid="search-modal"] button.flex.w-full')].map((row) => {
  const name = row.querySelector('span.font-semibold') as HTMLElement;
  const next = name.nextElementSibling as HTMLElement | null;
  return [name.textContent, next?.getAttribute('data-testid') === 'app-tag' ? next.textContent : null];
});

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('SearchModal — webhook-authored hits', () => {
  it('a server hit posted by a webhook named "Alice" carries the APP tag; the member Alice does not', async () => {
    mockGet.mockResolvedValue({ data: { success: true, data: [hit('m-1', hookAlice), hit('m-2', alice)], hasMore: false } });
    await render();
    await search('deploy');
    expect(mockGet).toHaveBeenCalledWith(expect.stringContaining('/search/servers/srv-1/messages?'), expect.anything());
    expect(rows()).toEqual([['Alice', 'messageItem.appTag'], ['Alice', null]]);
    expect(container.querySelectorAll('[data-testid="app-tag"]')).toHaveLength(1);
  });

  it('a deleted webhook\'s hit is tagged too', async () => {
    mockGet.mockResolvedValue({ data: { success: true, data: [hit('m-1', { ...hookAlice, id: 'webhook:deleted', displayName: 'Old CI' })], hasMore: false } });
    await render();
    await search('deploy');
    expect(rows()).toEqual([['Old CI', 'messageItem.appTag']]);
  });

  it('a local DM hit claiming a webhook author is never tagged (no webhook posts into a DM)', async () => {
    localDM.mockResolvedValue([hit('m-1', hookAlice, { channelId: null, conversationId: 'conv-1' })]);
    await render({ conversationId: 'conv-1' });
    await search('deploy');
    expect(localDM).toHaveBeenCalledWith('conv-1', 'deploy');
    expect(rows()).toEqual([['Alice', null]]);
  });

  it('a local secure-channel hit claiming a webhook author is never tagged (no webhook posts there)', async () => {
    localChannel.mockResolvedValue([hit('m-1', hookAlice, { channelId: 'ch-sec', channelName: 'vault' })]);
    mockGet.mockResolvedValue({ data: { success: true, data: [], hasMore: false } });
    await render();
    const select = container.querySelector('select') as HTMLSelectElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, 'ch-sec');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await search('deploy');
    expect(localChannel).toHaveBeenCalledWith('ch-sec', 'deploy');
    expect(rows()).toEqual([['Alice', null]]);
  });
});
