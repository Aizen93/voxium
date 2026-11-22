import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// A support system row reads in the viewer's language: the fixed sentences and
// the two name templates map to keys; an unknown sentence stays as it is.

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  const t = (k: string, o?: { name?: string }) => (o?.name !== undefined ? `${k}|${o.name}` : k);
  return { ...actual, useTranslation: () => ({ t }) };
});

const h = vi.hoisted(() => ({
  support: {
    ticket: { id: 't1', status: 'open' },
    messages: [] as unknown[],
    isLoading: false,
    sendMessage: vi.fn(),
    openTicket: vi.fn(),
    setShowSupportView: vi.fn(),
  },
}));
vi.mock('../../stores/supportStore', () => ({ useSupportStore: () => h.support }));
vi.mock('../../stores/authStore', () => ({
  useAuthStore: (sel: (s: { user: { id: string } }) => unknown) => sel({ user: { id: 'me' } }),
}));
vi.mock('../../components/common/Avatar', () => ({ Avatar: () => null }));
vi.mock('../../components/common/StaffBadge', () => ({ StaffBadge: () => null }));
vi.mock('../../stores/toastStore', () => ({ toast: { error: vi.fn() } }));

import { SupportTicketView } from '../../components/dm/SupportTicketView';

const row = (id: string, content: string) => ({
  id,
  ticketId: 't1',
  authorId: 'a',
  content,
  type: 'system',
  createdAt: '2026-01-01T00:00:00.000Z',
  author: { id: 'a', username: 'a', displayName: 'A', avatarUrl: null, role: 'admin' },
});

describe('SupportTicketView system rows', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    Element.prototype.scrollIntoView = vi.fn();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('maps known sentences and shows an unknown one as it is', () => {
    h.support.messages = [
      row('1', 'Support ticket opened'),
      row('2', 'Staff member <i>Dana</i> has joined the conversation'),
      row('3', 'Ticket closed by Dana'),
      row('4', 'Something the server never sent before'),
    ];
    act(() => root.render(<SupportTicketView />));
    const text = host.textContent ?? '';
    expect(text).toContain('support.noticeOpened');
    expect(text).toContain('support.noticeStaffJoined|<i>Dana</i>');
    expect(text).toContain('support.noticeClosedBy|Dana');
    expect(text).toContain('Something the server never sent before');
    expect(text).not.toContain('Support ticket opened');
    expect(host.querySelector('i')).toBeNull();
  });
});
