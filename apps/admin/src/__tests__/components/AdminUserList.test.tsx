import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, click, keyDown, type, getByRole, queryByRole, flush, type Mounted } from '../helpers/dom';

/**
 * The users list: its Delete and Ban buttons open the shared confirmation
 * dialog (the real one). Deleting asks for the account's username; banning
 * does not.
 */

const store = vi.hoisted(() => ({
  users: [] as Array<Record<string, unknown>>,
  usersTotal: 1,
  usersPage: 1,
  usersSearch: '',
  usersFilter: 'all',
  usersSort: 'newest',
  loading: false,
  fetchUsers: vi.fn(),
  setUsersSearch: vi.fn(),
  setUsersFilter: vi.fn(),
  setUsersSort: vi.fn(),
  banUser: vi.fn(),
  deleteUser: vi.fn(),
  fetchUserOwnedServers: vi.fn(),
}));
vi.mock('../../stores/adminStore', () => ({ useAdminStore: Object.assign(() => store, { getState: () => store }) }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('../../stores/toastStore', () => ({ toast }));
vi.mock('../../components/AdminRegistrationPanel', () => ({ AdminRegistrationPanel: () => null }));

import { AdminUserList } from '../../components/AdminUserList';

const USER = {
  id: 'u-7', username: 'carol', email: 'c@example.com', role: 'user', status: 'offline',
  createdAt: '2026-10-01T00:00:00.000Z', bannedAt: null, isSupporter: false, supporterTier: null,
};

let view: Mounted;
const input = () => getByRole('textbox', /Type carol to confirm/) as HTMLInputElement;
const dialogButton = (name: string) => {
  const dialog = document.querySelector('[role="dialog"]')!;
  return Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent?.trim() === name) as HTMLButtonElement;
};

async function renderList() {
  await view.render(<AdminUserList onSelectUser={vi.fn()} />);
  await flush();
}
async function openDelete() {
  await click(getByRole('button', 'Delete user'));
  await flush();
}

beforeEach(() => {
  vi.clearAllMocks();
  store.users = [USER];
  store.fetchUserOwnedServers.mockResolvedValue([]);
  store.deleteUser.mockResolvedValue(undefined);
  store.banUser.mockResolvedValue(undefined);
  view = mount();
});
afterEach(() => view.unmount());

describe('AdminUserList — deleting an account asks for its username', () => {
  async function expectTypedFlow() {
    expect(dialogButton('Delete').disabled).toBe(true);
    await click(dialogButton('Delete'));
    expect(store.deleteUser).not.toHaveBeenCalled();
    await type(input(), 'Carol');
    expect(dialogButton('Delete').disabled).toBe(true);
    await type(input(), 'carol');
    expect(dialogButton('Delete').disabled).toBe(false);
    await click(dialogButton('Delete'));
    await flush();
    expect(store.deleteUser).toHaveBeenCalledTimes(1);
    expect(store.deleteUser).toHaveBeenCalledWith('u-7');
  }

  it('an account with no owned spaces: Delete stays disabled until the exact username is typed', async () => {
    await renderList();
    await openDelete();
    await expectTypedFlow();
  });

  it('the fallback after a failed owned-spaces lookup asks for the username too', async () => {
    store.fetchUserOwnedServers.mockRejectedValue(new Error('boom'));
    await renderList();
    await openDelete();
    await expectTypedFlow();
  });

  it('Escape does not close the delete dialog', async () => {
    await renderList();
    await openDelete();
    await keyDown(document.body, 'Escape');
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });
});

describe('AdminUserList — banning is unchanged', () => {
  it('has no input, confirms at once, closes on Escape and bans once with the account id', async () => {
    await renderList();
    await click(getByRole('button', 'Ban user'));
    expect(queryByRole('textbox', /Type/)).toBeNull();
    expect(dialogButton('Ban').disabled).toBe(false);

    await keyDown(document.body, 'Escape');
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    await click(getByRole('button', 'Ban user'));
    await click(dialogButton('Ban'));
    await flush();
    expect(store.banUser).toHaveBeenCalledTimes(1);
    expect(store.banUser).toHaveBeenCalledWith('u-7');
    expect(store.deleteUser).not.toHaveBeenCalled();
  });
});
