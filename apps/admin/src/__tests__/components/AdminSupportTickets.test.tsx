import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SupportTicket, SupportMessageData } from '@voxium/shared';
import { mount, click, type, keyDown, getByRole, queryByRole, queryAllByRole, bodyText, flush, type Mounted } from '../helpers/dom';

/**
 * The support inbox: the ticket list on the left (filter tabs, pagination),
 * the open thread on the right (claim, close, reply). Success paths only: how
 * a failing claim, close or reply is reported is not pinned here.
 */

const store = vi.hoisted(() => ({
  supportTickets: [] as SupportTicket[],
  supportTicketsTotal: 0,
  supportTicketsPage: 1,
  supportTicketsFilter: 'all',
  activeTicket: null as SupportTicket | null,
  activeTicketMessages: [] as SupportMessageData[],
  fetchSupportTickets: vi.fn(),
  setSupportTicketsFilter: vi.fn(),
  setActiveTicket: vi.fn(),
  claimTicket: vi.fn(),
  sendTicketMessage: vi.fn(),
  closeTicket: vi.fn(),
  subscribeSupport: vi.fn(),
  unsubscribeSupport: vi.fn(),
}));
vi.mock('../../stores/adminStore', () => ({ useAdminStore: Object.assign(() => store, { getState: () => store }) }));

import { AdminSupportTickets } from '../../components/AdminSupportTickets';

function ticket(over: Partial<SupportTicket>): SupportTicket {
  return {
    id: 't-1', userId: 'u-1', username: 'carol', displayName: 'Carol', avatarUrl: null, status: 'open', claimedById: null,
    claimedByUsername: null, lastMessage: null, lastMessageAt: null, createdAt: '2026-10-05T09:00:00.000Z',
    updatedAt: '2026-10-05T09:00:00.000Z', ...over,
  };
}
function message(over: Partial<SupportMessageData> & { role?: 'user' | 'admin' | 'superadmin' }): SupportMessageData {
  const { role = 'user', ...rest } = over;
  return {
    id: 'm-1', ticketId: 't-1', authorId: 'u-1', content: 'Hello', type: 'user', createdAt: '2026-10-05T09:01:00.000Z',
    author: { id: 'u-1', username: 'carol', displayName: 'Carol', avatarUrl: null, role },
    ...rest,
  } as SupportMessageData;
}

const OPEN = ticket({ id: 't-1', displayName: 'Carol', username: 'carol', lastMessage: 'I cannot log in' });
const CLAIMED = ticket({ id: 't-2', displayName: 'Dave', username: 'dave', status: 'claimed', claimedById: 'a-1', claimedByUsername: 'root' });
const CLOSED = ticket({ id: 't-3', displayName: 'Erin', username: 'erin', status: 'closed' });

let view: Mounted;

async function renderInbox() {
  await view.render(<AdminSupportTickets />);
}
const composer = () => getByRole('textbox', 'Type a message...') as HTMLTextAreaElement;
// The send button is an icon without an accessible name: it is the composer's only button.
const sendButton = () => composer().parentElement!.querySelector('button') as HTMLButtonElement;

beforeEach(() => {
  vi.clearAllMocks();
  // jsdom has no layout: the thread scrolls its newest message into view
  Element.prototype.scrollIntoView = vi.fn();
  store.supportTickets = [OPEN, CLAIMED, CLOSED];
  store.supportTicketsTotal = 3;
  store.supportTicketsPage = 1;
  store.supportTicketsFilter = 'all';
  store.activeTicket = null;
  store.activeTicketMessages = [];
  store.claimTicket.mockResolvedValue(undefined);
  store.sendTicketMessage.mockResolvedValue(undefined);
  store.closeTicket.mockResolvedValue(undefined);
  view = mount();
});
afterEach(() => view.unmount());

describe('AdminSupportTickets — the list', () => {
  it('loads the first page and subscribes to live updates when it opens, and unsubscribes when it closes', async () => {
    await renderInbox();
    expect(store.fetchSupportTickets).toHaveBeenCalledWith(1);
    expect(store.subscribeSupport).toHaveBeenCalledTimes(1);
    expect(store.unsubscribeSupport).not.toHaveBeenCalled();
    view.unmount();
    expect(store.unsubscribeSupport).toHaveBeenCalledTimes(1);
    view = mount();
  });

  it('lists each ticket with its requester, handle, status and last message', async () => {
    await renderInbox();
    const text = bodyText();
    expect(text).toContain('Carol');
    expect(text).toContain('@carol');
    expect(text).toContain('I cannot log in');
    expect(text).toContain('Dave');
    expect(text).toContain('Claimed');
    expect(text).toContain('by root');
    expect(text).toContain('Erin');
    expect(text).toContain('Closed');
  });

  it('says so when there are no tickets, and asks to select one when none is open', async () => {
    store.supportTickets = [];
    store.supportTicketsTotal = 0;
    await renderInbox();
    expect(bodyText()).toContain('No tickets found');
    expect(bodyText()).toContain('Select a ticket to view');
  });

  it('selecting a ticket hands exactly that ticket to the store', async () => {
    await renderInbox();
    await click(getByRole('button', /^D.*Dave/));
    expect(store.setActiveTicket).toHaveBeenCalledTimes(1);
    expect(store.setActiveTicket).toHaveBeenCalledWith(CLAIMED);
  });

  it('the status tabs set the filter to their own value', async () => {
    await renderInbox();
    await click(getByRole('button', 'Open'));
    await click(getByRole('button', 'Claimed'));
    await click(getByRole('button', 'Closed'));
    await click(getByRole('button', 'All'));
    expect(store.setSupportTicketsFilter.mock.calls.map((c) => c[0])).toEqual(['open', 'claimed', 'closed', 'all']);
  });

  it('shows no pager for a single page, and pages forward and back for several', async () => {
    await renderInbox();
    expect(queryByRole('button', 'Next')).toBeNull();

    store.supportTicketsTotal = 30;
    store.supportTicketsPage = 2;
    await renderInbox();
    expect(bodyText()).toContain('2 / 3');
    store.fetchSupportTickets.mockClear();
    await click(getByRole('button', 'Next'));
    await click(getByRole('button', 'Previous'));
    expect(store.fetchSupportTickets.mock.calls.map((c) => c[0])).toEqual([3, 1]);
  });

  it('disables Previous on the first page and Next on the last', async () => {
    store.supportTicketsTotal = 30;
    store.supportTicketsPage = 1;
    await renderInbox();
    expect((getByRole('button', 'Previous') as HTMLButtonElement).disabled).toBe(true);
    store.supportTicketsPage = 3;
    await renderInbox();
    expect((getByRole('button', 'Next') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('AdminSupportTickets — the open thread', () => {
  it('shows the requester, the status and the messages, system notices apart and staff marked', async () => {
    store.activeTicket = CLAIMED;
    store.activeTicketMessages = [
      message({ id: 'm-1', content: 'My account is locked', author: { id: 'u-2', username: 'dave', displayName: 'Dave', avatarUrl: null, role: 'user' } }),
      message({ id: 'm-2', type: 'system', content: 'root claimed this ticket' }),
      message({ id: 'm-3', content: 'Looking into it', role: 'admin', author: { id: 'a-1', username: 'root', displayName: 'Root', avatarUrl: null, role: 'admin' } }),
    ];
    await renderInbox();
    const text = bodyText();
    expect(text).toContain('My account is locked');
    expect(text).toContain('root claimed this ticket');
    expect(text).toContain('Looking into it');
    expect(text).toContain('Staff');
    expect(text).not.toContain('Select a ticket to view');
  });

  it('says "No messages yet" for an empty thread', async () => {
    store.activeTicket = OPEN;
    await renderInbox();
    expect(bodyText()).toContain('No messages yet');
  });

  it('renders message text as text, never as markup', async () => {
    store.activeTicket = OPEN;
    store.activeTicketMessages = [message({ content: '<img src=x onerror="alert(1)">' })];
    await renderInbox();
    expect(document.body.querySelector('img')).toBeNull();
    expect(bodyText()).toContain('<img src=x onerror="alert(1)">');
  });
});

describe('AdminSupportTickets — claim and close', () => {
  it('Claim claims the open ticket by its id', async () => {
    store.activeTicket = OPEN;
    await renderInbox();
    await click(getByRole('button', 'Claim'));
    expect(store.claimTicket).toHaveBeenCalledTimes(1);
    expect(store.claimTicket).toHaveBeenCalledWith('t-1');
    expect(store.closeTicket).not.toHaveBeenCalled();
  });

  it('Close closes the open ticket by its id', async () => {
    store.activeTicket = OPEN;
    await renderInbox();
    await click(getByRole('button', 'Close'));
    expect(store.closeTicket).toHaveBeenCalledTimes(1);
    expect(store.closeTicket).toHaveBeenCalledWith('t-1');
    expect(store.claimTicket).not.toHaveBeenCalled();
  });

  it('a claimed ticket can be closed but not claimed again', async () => {
    store.activeTicket = CLAIMED;
    await renderInbox();
    expect(queryByRole('button', 'Claim')).toBeNull();
    await click(getByRole('button', 'Close'));
    expect(store.closeTicket).toHaveBeenCalledWith('t-2');
  });

  it('a closed ticket offers neither Claim, Close nor a reply box', async () => {
    store.activeTicket = CLOSED;
    await renderInbox();
    expect(queryByRole('button', 'Claim')).toBeNull();
    expect(queryByRole('button', 'Close')).toBeNull();
    expect(queryByRole('textbox', 'Type a message...')).toBeNull();
  });
});

describe('AdminSupportTickets — replying', () => {
  beforeEach(() => {
    store.activeTicket = CLAIMED;
  });

  it('sends the typed text to the open ticket by its id, then empties the box', async () => {
    await renderInbox();
    await type(composer(), 'Try resetting your password');
    await click(sendButton());
    await flush();
    expect(store.sendTicketMessage).toHaveBeenCalledTimes(1);
    expect(store.sendTicketMessage).toHaveBeenCalledWith('t-2', 'Try resetting your password');
    expect(composer().value).toBe('');
  });

  it('trims the text it sends', async () => {
    await renderInbox();
    await type(composer(), '   padded reply \n');
    await click(sendButton());
    await flush();
    expect(store.sendTicketMessage).toHaveBeenCalledWith('t-2', 'padded reply');
  });

  it('Enter sends, and Shift+Enter does not', async () => {
    await renderInbox();
    await type(composer(), 'with shift');
    await keyDown(composer(), 'Enter', { shiftKey: true });
    expect(store.sendTicketMessage).not.toHaveBeenCalled();
    await keyDown(composer(), 'Enter');
    await flush();
    expect(store.sendTicketMessage).toHaveBeenCalledWith('t-2', 'with shift');
  });

  it('does not send an empty reply: the button is disabled and Enter does nothing', async () => {
    await renderInbox();
    expect(sendButton().disabled).toBe(true);
    await click(sendButton());
    await keyDown(composer(), 'Enter');
    expect(store.sendTicketMessage).not.toHaveBeenCalled();
  });

  it('does not send a reply of only blanks', async () => {
    await renderInbox();
    await type(composer(), '   \n  ');
    expect(sendButton().disabled).toBe(true);
    await keyDown(composer(), 'Enter');
    await flush();
    expect(store.sendTicketMessage).not.toHaveBeenCalled();
    expect(composer().value).toBe('   \n  ');
  });

  it('cannot send the same reply twice while the first is in flight', async () => {
    let resolve!: () => void;
    store.sendTicketMessage.mockReturnValue(new Promise<void>((r) => { resolve = r; }));
    await renderInbox();
    await type(composer(), 'once');
    await keyDown(composer(), 'Enter');
    await keyDown(composer(), 'Enter');
    await click(sendButton());
    expect(store.sendTicketMessage).toHaveBeenCalledTimes(1);
    resolve();
    await flush();
    expect(queryAllByRole('textbox', 'Type a message...')).toHaveLength(1);
  });
});
