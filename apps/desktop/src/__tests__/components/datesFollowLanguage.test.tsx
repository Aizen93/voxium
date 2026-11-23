import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Message, ServerBan } from '@voxium/shared';

// A date on screen is in the language chosen in the app, and it changes when
// that language changes, without a reload. Real i18n, real components; the
// expected text comes from Intl.DateTimeFormat given the same language and
// options here.

import i18n from '../../i18n';
import { DeleteConfirmModal } from '../../components/chat/DeleteConfirmModal';
import { DeletedMessageRow } from '../../components/dm/DeletedParticipant';
import { BannedSection } from '../../components/server/BannedSection';
import { useServerStore } from '../../stores/serverStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OLD = '2025-03-09T14:05:00';
const DATE_TIME = { dateStyle: 'medium', timeStyle: 'short' } as const;
const at = (language: string) => new Intl.DateTimeFormat(language, DATE_TIME).format(new Date(OLD));

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  await i18n.changeLanguage('en');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  act(() => root.unmount());
  container.remove();
  await i18n.changeLanguage('en');
});

describe('a date on screen follows the language of the app', () => {
  it('the delete confirmation shows the message time in the chosen language and changes with it', async () => {
    const message = {
      id: 'm1',
      content: 'hello',
      createdAt: OLD,
      author: { id: 'u1', displayName: 'Ana' },
    } as unknown as Message;
    await act(async () => {
      root.render(<DeleteConfirmModal message={message} channelId="c1" onClose={() => {}} />);
    });
    expect(container.textContent).toContain(at('en'));
    await act(async () => {
      await i18n.changeLanguage('fr');
    });
    expect(container.textContent).toContain(at('fr'));
    expect(container.textContent).not.toContain(at('en'));
    await act(async () => {
      await i18n.changeLanguage('ja');
    });
    expect(container.textContent).toContain(at('ja'));
  });

  it('the deleted-account row prints its time in the chosen language', async () => {
    await i18n.changeLanguage('de');
    await act(async () => {
      root.render(<DeletedMessageRow messageId="m1" createdAt={OLD} />);
    });
    expect(container.textContent).toContain(at('de'));
    await act(async () => {
      await i18n.changeLanguage('ar');
    });
    expect(container.textContent).toContain(at('ar'));
  });

  it('the ban list prints when a person was banned in the chosen language', async () => {
    const ban = {
      serverId: 's1',
      userId: 'u2',
      reason: null,
      createdAt: OLD,
      user: { id: 'u2', username: 'bo', displayName: 'Bo', avatarUrl: null },
      bannedBy: null,
    } as unknown as ServerBan;
    useServerStore.setState({ bans: [ban], bansServerId: 's1', fetchBans: vi.fn().mockResolvedValue(undefined) });
    await i18n.changeLanguage('fr');
    await act(async () => {
      root.render(<BannedSection serverId="s1" />);
    });
    expect(container.querySelector('[data-testid="ban-row"]')?.textContent).toContain(at('fr'));
    await act(async () => {
      await i18n.changeLanguage('en');
    });
    expect(container.querySelector('[data-testid="ban-row"]')?.textContent).toContain(at('en'));
  });
});
