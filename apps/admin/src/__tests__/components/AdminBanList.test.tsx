import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { BanRecord, IpBanRecord } from '@voxium/shared';
import { mount, click, type, getByRole, queryByRole, queryAllByRole, bodyText, flush, type Mounted } from '../helpers/dom';

/**
 * The ban list: account bans and IP bans in two tabs, an unban and an IP-ban
 * removal that each ask first, and an "Add IP Ban" form that checks the
 * address (IPv4 by pattern, IPv6 through the URL parser) before it sends it.
 */

const store = vi.hoisted(() => ({
  bans: [] as BanRecord[],
  bansTotal: 0,
  bansPage: 1,
  ipBans: [] as IpBanRecord[],
  ipBansTotal: 0,
  ipBansPage: 1,
  fetchBans: vi.fn(),
  fetchIpBans: vi.fn(),
  unbanUser: vi.fn(),
  addIpBan: vi.fn(),
  removeIpBan: vi.fn(),
}));
vi.mock('../../stores/adminStore', () => ({ useAdminStore: Object.assign(() => store, { getState: () => store }) }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('../../stores/toastStore', () => ({ toast }));

import { AdminBanList } from '../../components/AdminBanList';

const BAN_A: BanRecord = {
  id: 'u-1', username: 'spammer', displayName: 'Spammer', email: 'spam@example.com',
  bannedAt: '2026-10-01T10:00:00.000Z', banReason: 'Posting links',
};
const BAN_B: BanRecord = {
  id: 'u-2', username: 'troll', displayName: 'Troll', email: 'troll@example.com',
  bannedAt: '2026-10-02T10:00:00.000Z', banReason: null,
};
const IP_A: IpBanRecord = {
  id: 'ip-1', ip: '203.0.113.7', reason: 'Botnet', bannedBy: 'adm-1', bannedByUsername: 'root', createdAt: '2026-10-03T10:00:00.000Z',
};
const IP_B: IpBanRecord = {
  id: 'ip-2', ip: '2001:db8::1', reason: null, bannedBy: 'adm-1', bannedByUsername: 'root', createdAt: '2026-10-04T10:00:00.000Z',
};

let view: Mounted;

async function renderList() {
  await view.render(<AdminBanList />);
}
async function openIpTab() {
  await click(getByRole('button', /^IP Bans/));
}
async function openAddForm() {
  await openIpTab();
  await click(getByRole('button', 'Add IP Ban'));
}
// The row buttons are named by their title; the dialog's own confirm button comes last in the page.
const confirmUnban = () => queryAllByRole('button', 'Unban').at(-1)!;
const addressBox = () => getByRole('textbox', 'IP Address') as HTMLInputElement;
const reasonBox = () => getByRole('textbox', 'Reason (optional)') as HTMLInputElement;

async function submitAddress(address: string, reason = '') {
  await type(addressBox(), address);
  if (reason) await type(reasonBox(), reason);
  await click(getByRole('button', 'Ban IP'));
}

beforeEach(() => {
  vi.clearAllMocks();
  store.bans = [BAN_A, BAN_B];
  store.bansTotal = 2;
  store.ipBans = [IP_A, IP_B];
  store.ipBansTotal = 2;
  store.fetchBans.mockResolvedValue(undefined);
  store.fetchIpBans.mockResolvedValue(undefined);
  store.unbanUser.mockResolvedValue(undefined);
  store.addIpBan.mockResolvedValue(undefined);
  store.removeIpBan.mockResolvedValue(undefined);
  view = mount();
});
afterEach(() => view.unmount());

describe('AdminBanList — what it shows', () => {
  it('loads the first page of both lists when it opens', async () => {
    await renderList();
    expect(store.fetchBans).toHaveBeenCalledWith(1);
    expect(store.fetchIpBans).toHaveBeenCalledWith(1);
  });

  it('lists each banned account with its email and reason, and says "No reason" when there is none', async () => {
    await renderList();
    const [, withReason, withoutReason] = queryAllByRole('row');
    expect(withReason.textContent).toContain('spammer');
    expect(withReason.textContent).toContain('spam@example.com');
    expect(withReason.textContent).toContain('Posting links');
    expect(withoutReason.textContent).toContain('troll');
    expect(withoutReason.textContent).toContain('No reason');
  });

  it('shows the counts on both tabs', async () => {
    store.bansTotal = 7;
    store.ipBansTotal = 3;
    await renderList();
    expect(getByRole('button', 'Account Bans (7)')).toBeTruthy();
    expect(getByRole('button', 'IP Bans (3)')).toBeTruthy();
  });

  it('shows "No results found" for an empty account list, and no unban control', async () => {
    store.bans = [];
    store.bansTotal = 0;
    await renderList();
    expect(bodyText()).toContain('No results found');
    expect(queryByRole('button', 'Unban')).toBeNull();
  });

  it('has no loading indicator of its own: before the first answer it shows the empty table', async () => {
    store.bans = [];
    store.bansTotal = 0;
    store.fetchBans.mockReturnValue(new Promise(() => {}));
    await renderList();
    expect(bodyText()).toContain('No results found');
  });

  it('switching to the IP tab shows the addresses with who banned them, and fetches that list again', async () => {
    await renderList();
    store.fetchIpBans.mockClear();
    await openIpTab();
    expect(store.fetchIpBans).toHaveBeenCalledTimes(1);
    const text = bodyText();
    expect(text).toContain('203.0.113.7');
    expect(text).toContain('2001:db8::1');
    expect(text).toContain('Botnet');
    expect(text).toContain('root');
    expect(text).not.toContain('spam@example.com');
  });

  it('shows "No results found" for an empty IP list', async () => {
    store.ipBans = [];
    store.ipBansTotal = 0;
    await renderList();
    await openIpTab();
    expect(bodyText()).toContain('No results found');
  });

  it('offers "Add IP Ban" on the IP tab only', async () => {
    await renderList();
    expect(queryByRole('button', 'Add IP Ban')).toBeNull();
    await openIpTab();
    expect(getByRole('button', 'Add IP Ban')).toBeTruthy();
  });
});

describe('AdminBanList — unban', () => {
  it('asks first, naming the account, and sends nothing until the answer', async () => {
    await renderList();
    await click(queryAllByRole('button', 'Unban')[0]);
    expect(bodyText()).toContain('Remove account ban from "spammer"?');
    expect(getByRole('heading', 'Unban User')).toBeTruthy();
    expect(store.unbanUser).not.toHaveBeenCalled();
  });

  it('does nothing when the question is cancelled', async () => {
    await renderList();
    await click(queryAllByRole('button', 'Unban')[0]);
    await click(getByRole('button', 'Cancel'));
    expect(store.unbanUser).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(bodyText()).not.toContain('Remove account ban from');
  });

  it('unbans the account that was clicked, by its id, then reloads both lists', async () => {
    await renderList();
    await click(queryAllByRole('button', 'Unban')[1]);
    expect(bodyText()).toContain('Remove account ban from "troll"?');
    store.fetchBans.mockClear();
    store.fetchIpBans.mockClear();
    await click(confirmUnban());
    await flush();
    expect(store.unbanUser).toHaveBeenCalledTimes(1);
    expect(store.unbanUser).toHaveBeenCalledWith('u-2');
    expect(toast.success).toHaveBeenCalledWith('User unbanned');
    expect(store.fetchBans).toHaveBeenCalledTimes(1);
    expect(store.fetchIpBans).toHaveBeenCalledTimes(1);
    expect(bodyText()).not.toContain('Remove account ban from');
  });

  it('shows "Failed to unban user" when the action fails, reloads nothing and closes the question', async () => {
    store.unbanUser.mockRejectedValue(new Error('boom'));
    await renderList();
    await click(queryAllByRole('button', 'Unban')[0]);
    store.fetchBans.mockClear();
    await click(confirmUnban());
    await flush();
    expect(toast.error).toHaveBeenCalledWith('Failed to unban user');
    expect(toast.success).not.toHaveBeenCalled();
    expect(store.fetchBans).not.toHaveBeenCalled();
    expect(bodyText()).not.toContain('Remove account ban from');
  });
});

describe('AdminBanList — removing an IP ban', () => {
  it('asks first, naming the address, and removes nothing when cancelled', async () => {
    await renderList();
    await openIpTab();
    await click(queryAllByRole('button', 'Remove ban')[0]);
    expect(getByRole('heading', 'Remove IP Ban')).toBeTruthy();
    expect(bodyText()).toContain('Remove IP ban for 203.0.113.7?');
    await click(getByRole('button', 'Cancel'));
    expect(store.removeIpBan).not.toHaveBeenCalled();
  });

  it('removes the ban that was clicked, by its id', async () => {
    await renderList();
    await openIpTab();
    await click(queryAllByRole('button', 'Remove ban')[1]);
    await click(getByRole('button', 'Remove'));
    await flush();
    expect(store.removeIpBan).toHaveBeenCalledTimes(1);
    expect(store.removeIpBan).toHaveBeenCalledWith('ip-2');
    expect(toast.success).toHaveBeenCalledWith('IP ban removed');
  });

  it('shows "Failed to remove IP ban" when the action fails', async () => {
    store.removeIpBan.mockRejectedValue(new Error('boom'));
    await renderList();
    await openIpTab();
    await click(queryAllByRole('button', 'Remove ban')[0]);
    await click(getByRole('button', 'Remove'));
    await flush();
    expect(toast.error).toHaveBeenCalledWith('Failed to remove IP ban');
    expect(toast.success).not.toHaveBeenCalled();
  });
});

describe('AdminBanList — adding an IP ban', () => {
  it('opens a form with the address and the optional reason, and Cancel closes it without sending', async () => {
    await renderList();
    await openAddForm();
    expect(getByRole('heading', 'Add IP Ban')).toBeTruthy();
    await type(addressBox(), '198.51.100.1');
    await click(getByRole('button', 'Cancel'));
    expect(queryByRole('heading', 'Add IP Ban')).toBeNull();
    expect(store.addIpBan).not.toHaveBeenCalled();
    // reopening starts from an empty form
    await click(getByRole('button', 'Add IP Ban'));
    expect(addressBox().value).toBe('');
  });

  it('sends nothing for an empty or blank address, and shows no message', async () => {
    await renderList();
    await openAddForm();
    await submitAddress('   ');
    expect(store.addIpBan).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it.each(['203.0.113.7', '0.0.0.0', '255.255.255.255', '10.0.0.1'])('accepts the IPv4 address %s', async (address) => {
    await renderList();
    await openAddForm();
    await submitAddress(address);
    await flush();
    expect(store.addIpBan).toHaveBeenCalledWith(address, undefined);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it.each(['::1', '::', '2001:db8::1', 'fe80::1', '2001:db8:85a3::8a2e:370:7334'])('accepts the IPv6 address %s', async (address) => {
    await renderList();
    await openAddForm();
    await submitAddress(address);
    await flush();
    expect(store.addIpBan).toHaveBeenCalledWith(address, undefined);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it.each([
    ['an octet above 255', '256.1.1.1'],
    ['an octet above 255 at the end', '1.2.3.999'],
    ['three octets', '1.2.3'],
    ['five octets', '1.2.3.4.5'],
    ['letters', 'not-an-ip'],
    ['a hostname', 'example.com'],
    ['an IPv4 with a port', '1.2.3.4:80'],
    ['an IPv4 with a path', '1.2.3.4/24'],
    ['an IPv6 with too many groups', '1:2:3:4:5:6:7:8:9'],
    ['an IPv6 group of five digits', '12345::1'],
    ['an IPv6 with two compressions', '1::2::3'],
    ['a bracketed IPv6', '[::1]'],
    ['an address smuggling a path', '::1]/evil['],
  ])('refuses %s (%s) with "Invalid IP address format" and sends nothing', async (_what, address) => {
    await renderList();
    await openAddForm();
    await submitAddress(address);
    await flush();
    expect(toast.error).toHaveBeenCalledWith('Invalid IP address format');
    expect(store.addIpBan).not.toHaveBeenCalled();
    // the form stays open for another try
    expect(getByRole('heading', 'Add IP Ban')).toBeTruthy();
  });

  it('trims the address and passes the typed reason along', async () => {
    await renderList();
    await openAddForm();
    await submitAddress('  198.51.100.9  ', 'Scanner');
    await flush();
    expect(store.addIpBan).toHaveBeenCalledWith('198.51.100.9', 'Scanner');
  });

  it('on success confirms, closes the form and clears it', async () => {
    await renderList();
    await openAddForm();
    await submitAddress('198.51.100.9', 'Scanner');
    await flush();
    expect(toast.success).toHaveBeenCalledWith('IP banned');
    expect(queryByRole('heading', 'Add IP Ban')).toBeNull();
    await click(getByRole('button', 'Add IP Ban'));
    expect(addressBox().value).toBe('');
    expect(reasonBox().value).toBe('');
  });

  it('shows "Failed to add IP ban" when the action fails, and keeps the form with what was typed', async () => {
    store.addIpBan.mockRejectedValue(new Error('boom'));
    await renderList();
    await openAddForm();
    await submitAddress('198.51.100.9', 'Scanner');
    await flush();
    expect(toast.error).toHaveBeenCalledWith('Failed to add IP ban');
    expect(toast.success).not.toHaveBeenCalled();
    expect(addressBox().value).toBe('198.51.100.9');
    expect(reasonBox().value).toBe('Scanner');
  });

  // The IPv6 check compares the URL parser's hostname with the typed text, so
  // an address the parser rewrites (upper case, zero groups written out, an
  // embedded IPv4) is refused although it is valid. AdminBanList.tsx:156-157.
  it.fails('accepts an upper-case IPv6 address', async () => {
    await renderList();
    await openAddForm();
    await submitAddress('2001:DB8::1');
    await flush();
    expect(store.addIpBan).toHaveBeenCalledWith('2001:DB8::1', undefined);
  });

  it.fails('accepts an IPv6 address written with all its groups', async () => {
    await renderList();
    await openAddForm();
    await submitAddress('2001:0db8:0000:0000:0000:0000:0000:0001');
    await flush();
    expect(store.addIpBan).toHaveBeenCalledWith('2001:0db8:0000:0000:0000:0000:0000:0001', undefined);
  });
});
