import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AxiosError, AxiosHeaders, type InternalAxiosRequestConfig } from 'axios';
import type { OwnedServerInfo } from '../../stores/adminStore';
import { mount, click, choose, type, keyDown, deferred, getByRole, queryByRole, queryAllByRole, bodyText, flush, type Mounted } from '../helpers/dom';

/**
 * The delete-account modal: it lists the spaces the account owns, makes the
 * admin pick transfer-to-an-heir or delete for each, and only then offers the
 * destructive button. The button works once every transfer names an heir and
 * the admin has typed the account's username.
 */

const store = vi.hoisted(() => ({
  fetchUserOwnedServers: vi.fn(),
  deleteUserWithTransfers: vi.fn(),
}));
vi.mock('../../stores/adminStore', () => ({ useAdminStore: Object.assign(() => store, { getState: () => store }) }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('../../stores/toastStore', () => ({ toast }));

import { AdminDeleteUserModal } from '../../components/AdminDeleteUserModal';

function member(userId: string, role: string) {
  return { userId, username: `${userId}-name`, displayName: `${userId} Display`, role };
}
function owned(over: Partial<OwnedServerInfo>): OwnedServerInfo {
  return {
    id: 's', name: 'Server', iconUrl: null, memberCount: 1, members: [], description: null, tags: [], discoverable: false,
    discoveryListed: false, joinMode: 'approval', featuredAt: null, discoveryBlockedAt: null, invitesLocked: false, ownerBannedAt: null, ...over,
  };
}
const RAID = owned({
  id: 's-1', name: 'Raid Night', memberCount: 3,
  members: [member('m-1', 'member'), member('m-2', 'admin'), member('m-3', 'member')],
});
const EMPTY = owned({ id: 's-2', name: 'Ghost Town', memberCount: 0, members: [] });

function refusal(data: Record<string, unknown>) {
  return new AxiosError('Request failed', 'ERR_BAD_REQUEST', undefined, undefined, {
    status: 400, statusText: 'Bad Request', data, headers: {}, config: { headers: new AxiosHeaders() } as InternalAxiosRequestConfig,
  });
}

const onSuccess = vi.fn();
const onCancel = vi.fn();
let view: Mounted;

async function renderModal(servers: OwnedServerInfo[] = [RAID], typedName: string | null = 'alice') {
  store.fetchUserOwnedServers.mockResolvedValue(servers);
  await view.render(<AdminDeleteUserModal userId="u-9" username="alice" onSuccess={onSuccess} onCancel={onCancel} />);
  await flush();
  if (typedName !== null) await typeName(typedName);
}
const nameInput = () => getByRole('textbox', /Type alice to confirm/) as HTMLInputElement;
const typeName = (value: string) => type(nameInput(), value);
const destructive = () => getByRole('button', /Confirm & Delete User|Deleting\.\.\./) as HTMLButtonElement;
const heirSelects = () => queryAllByRole('combobox') as HTMLSelectElement[];
const transferButtons = () => queryAllByRole('button', 'Transfer') as HTMLButtonElement[];
const deleteButtons = () => queryAllByRole('button', 'Delete') as HTMLButtonElement[];

beforeEach(() => {
  vi.clearAllMocks();
  store.deleteUserWithTransfers.mockResolvedValue(undefined);
  view = mount();
});
afterEach(() => view.unmount());

describe('AdminDeleteUserModal — what it shows', () => {
  it('names the account in its heading and in the closing sentence', async () => {
    await renderModal();
    expect(getByRole('heading', 'Delete alice')).toBeTruthy();
    expect(bodyText()).toContain('permanently delete user "alice"');
  });

  it('asks the store for the spaces of that very account', async () => {
    await renderModal();
    expect(store.fetchUserOwnedServers).toHaveBeenCalledWith('u-9');
  });

  it('offers no destructive button while the spaces are loading', async () => {
    store.fetchUserOwnedServers.mockReturnValue(new Promise(() => {}));
    await view.render(<AdminDeleteUserModal userId="u-9" username="alice" onSuccess={onSuccess} onCancel={onCancel} />);
    expect(queryByRole('button', 'Confirm & Delete User')).toBeNull();
    expect(bodyText()).not.toContain('This user owns');
  });

  it('shows the load failure and offers no destructive button when the spaces cannot be read', async () => {
    store.fetchUserOwnedServers.mockRejectedValue(new Error('boom'));
    await view.render(<AdminDeleteUserModal userId="u-9" username="alice" onSuccess={onSuccess} onCancel={onCancel} />);
    await flush();
    expect(bodyText()).toContain('Failed to load owned servers');
    expect(queryByRole('button', 'Confirm & Delete User')).toBeNull();
    expect(queryByRole('button', 'Cancel')).toBeNull();
  });

  it('lists each owned space with its member count and offers Transfer and Delete for it', async () => {
    await renderModal([RAID, EMPTY]);
    expect(bodyText()).toContain('This user owns 2 server(s)');
    expect(bodyText()).toContain('Raid Night');
    expect(bodyText()).toContain('3 member(s)');
    expect(bodyText()).toContain('Ghost Town');
    expect(transferButtons()).toHaveLength(2);
    expect(deleteButtons()).toHaveLength(2);
  });

  it('defaults a space with members to Transfer, heir first among admins and owners', async () => {
    await renderModal();
    const [select] = heirSelects();
    expect(select.value).toBe('m-2');
    const options = Array.from(select.querySelectorAll('option')).map((o) => o.textContent);
    expect(options).toEqual([
      'm-1 Display (@m-1-name), member',
      'm-2 Display (@m-2-name), admin',
      'm-3 Display (@m-3-name), member',
    ]);
  });

  it('falls back to the first member as the heir when nobody is admin or owner', async () => {
    await renderModal([owned({ id: 's-3', name: 'Plain', members: [member('p-1', 'member'), member('p-2', 'member')] })]);
    expect(heirSelects()[0].value).toBe('p-1');
  });

  it('defaults a space with no other member to Delete, with Transfer disabled and no heir list', async () => {
    await renderModal([EMPTY]);
    expect(transferButtons()[0].disabled).toBe(true);
    expect(heirSelects()).toHaveLength(0);
    expect(bodyText()).toContain('delete 1 server(s)');
    expect(bodyText()).not.toContain('Transfer 1 server(s)');
  });

  it('summarises the plan: how many spaces are transferred and how many deleted', async () => {
    await renderModal([RAID, EMPTY]);
    expect(bodyText()).toContain('Transfer 1 server(s), delete 1 server(s) and permanently delete user "alice".');
  });
});

describe('AdminDeleteUserModal — what reaches the store', () => {
  it('sends a transfer to the default heir, with exactly the space id, the action and the heir', async () => {
    await renderModal();
    await click(destructive());
    await flush();
    expect(store.deleteUserWithTransfers).toHaveBeenCalledTimes(1);
    expect(store.deleteUserWithTransfers).toHaveBeenCalledWith('u-9', [
      { serverId: 's-1', action: 'transfer', newOwnerId: 'm-2' },
    ]);
  });

  it('sends the heir the admin picked instead', async () => {
    await renderModal();
    await choose(heirSelects()[0], 'm-3');
    await click(destructive());
    await flush();
    expect(store.deleteUserWithTransfers).toHaveBeenCalledWith('u-9', [
      { serverId: 's-1', action: 'transfer', newOwnerId: 'm-3' },
    ]);
  });

  it('sends a delete without any heir key when the admin chose to delete the space', async () => {
    await renderModal();
    await click(deleteButtons()[0]);
    expect(heirSelects()).toHaveLength(0);
    await click(destructive());
    await flush();
    const [, actions] = store.deleteUserWithTransfers.mock.calls[0];
    expect(actions).toEqual([{ serverId: 's-1', action: 'delete' }]);
    expect('newOwnerId' in actions[0]).toBe(false);
  });

  it('switching a space back to Transfer keeps the heir that was picked before', async () => {
    await renderModal();
    await choose(heirSelects()[0], 'm-1');
    await click(deleteButtons()[0]);
    await click(transferButtons()[0]);
    await click(destructive());
    await flush();
    expect(store.deleteUserWithTransfers).toHaveBeenCalledWith('u-9', [{ serverId: 's-1', action: 'transfer', newOwnerId: 'm-1' }]);
  });

  it('sends one entry per space, in list order, each with its own choice', async () => {
    const second = owned({ id: 's-4', name: 'Second', members: [member('q-1', 'owner'), member('q-2', 'member')] });
    await renderModal([RAID, EMPTY, second]);
    await choose(heirSelects()[1], 'q-2');
    await click(destructive());
    await flush();
    expect(store.deleteUserWithTransfers).toHaveBeenCalledWith('u-9', [
      { serverId: 's-1', action: 'transfer', newOwnerId: 'm-2' },
      { serverId: 's-2', action: 'delete' },
      { serverId: 's-4', action: 'transfer', newOwnerId: 'q-2' },
    ]);
  });

  it('sends an empty list for an account that owns no space, after the button is pressed', async () => {
    await renderModal([]);
    expect(bodyText()).toContain('This user owns 0 server(s)');
    expect(store.deleteUserWithTransfers).not.toHaveBeenCalled();
    await click(destructive());
    await flush();
    expect(store.deleteUserWithTransfers).toHaveBeenCalledWith('u-9', []);
  });

  it('confirms and reports success once the deletion went through', async () => {
    await renderModal();
    await click(destructive());
    await flush();
    expect(toast.success).toHaveBeenCalledWith('User deleted successfully');
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('calls nothing on the store before the destructive button is pressed', async () => {
    await renderModal([RAID, EMPTY]);
    await choose(heirSelects()[0], 'm-1');
    await click(deleteButtons()[0]);
    expect(store.deleteUserWithTransfers).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
  });
});

describe('AdminDeleteUserModal — the requirement before the destructive button works', () => {
  it('has no checkbox; the button is enabled once the name is typed and every transfer has an heir', async () => {
    await renderModal();
    expect(queryAllByRole('checkbox')).toHaveLength(0);
    expect(destructive().disabled).toBe(false);
  });

  it('keeps the button disabled, and sends nothing, while a transfer has no heir', async () => {
    // A member row without a user id leaves the transfer without a usable heir.
    await renderModal([owned({ id: 's-5', name: 'Broken', members: [member('', 'admin')] })]);
    expect(destructive().disabled).toBe(true);
    await click(destructive());
    expect(store.deleteUserWithTransfers).not.toHaveBeenCalled();
  });

  it('enables the button again once that space is switched to Delete', async () => {
    await renderModal([owned({ id: 's-5', name: 'Broken', members: [member('', 'admin')] })]);
    await click(deleteButtons()[0]);
    expect(destructive().disabled).toBe(false);
  });

  it('needs the name on top of the heirs: either one missing keeps the button disabled', async () => {
    await renderModal([owned({ id: 's-5', name: 'Broken', members: [member('', 'admin')] })]);
    await click(deleteButtons()[0]);
    expect(destructive().disabled).toBe(false);
    await typeName('');
    expect(destructive().disabled).toBe(true);
    await typeName('alice');
    await click(transferButtons()[0]);
    expect(destructive().disabled).toBe(true);
  });
});

describe('AdminDeleteUserModal — the typed username', () => {
  it('starts with an empty, labelled input that is not autofilled, and a disabled button', async () => {
    await renderModal([RAID], null);
    expect(nameInput().value).toBe('');
    expect(nameInput().getAttribute('autocomplete')).toBe('off');
    expect(nameInput().getAttribute('spellcheck')).toBe('false');
    expect(document.querySelector('label code')?.textContent).toBe('alice');
    expect(destructive().disabled).toBe(true);
  });

  it('refuses a wrong name and a name differing only by case, and says it is case-sensitive for the latter', async () => {
    await renderModal([RAID], null);
    await typeName('bob');
    expect(destructive().disabled).toBe(true);
    expect(bodyText()).not.toContain('case-sensitive');
    await typeName('ALICE');
    expect(destructive().disabled).toBe(true);
    expect(bodyText()).toContain('The name is case-sensitive.');
    await click(destructive());
    expect(store.deleteUserWithTransfers).not.toHaveBeenCalled();
  });

  it('accepts the right name with surrounding spaces', async () => {
    await renderModal([RAID], '  alice ');
    expect(destructive().disabled).toBe(false);
    await click(destructive());
    await flush();
    expect(store.deleteUserWithTransfers).toHaveBeenCalledTimes(1);
  });

  it('Enter in the input deletes only while the name matches', async () => {
    await renderModal([RAID], 'alic');
    await keyDown(nameInput(), 'Enter');
    expect(store.deleteUserWithTransfers).not.toHaveBeenCalled();
    await typeName('alice');
    await keyDown(nameInput(), 'Enter');
    await flush();
    expect(store.deleteUserWithTransfers).toHaveBeenCalledTimes(1);
  });

  it('disables the input while the request is in flight and keeps the typed value after a refusal', async () => {
    const pending = deferred();
    store.deleteUserWithTransfers.mockReturnValue(pending.promise);
    await renderModal();
    await click(destructive());
    expect(nameInput().disabled).toBe(true);
    pending.reject(new Error('boom'));
    await flush();
    expect(nameInput().disabled).toBe(false);
    expect(nameInput().value).toBe('alice');
    expect(getByRole('heading', 'Delete alice')).toBeTruthy();
  });

  it('cannot be confirmed for an account with no username', async () => {
    store.fetchUserOwnedServers.mockResolvedValue([RAID]);
    await view.render(<AdminDeleteUserModal userId="u-9" username="" onSuccess={onSuccess} onCancel={onCancel} />);
    await flush();
    expect(queryAllByRole('textbox')).toHaveLength(0);
    expect(bodyText()).toContain('no username to type');
    expect(destructive().disabled).toBe(true);
    await click(destructive());
    expect(store.deleteUserWithTransfers).not.toHaveBeenCalled();
  });
});

describe('AdminDeleteUserModal — cancelling and failing', () => {
  it('Cancel closes without calling the store', async () => {
    await renderModal();
    await click(getByRole('button', 'Cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(store.deleteUserWithTransfers).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('the close icon in the header, named "Close", cancels too', async () => {
    await renderModal();
    await click(getByRole('button', 'Close'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(store.deleteUserWithTransfers).not.toHaveBeenCalled();
  });

  it('Cancel is also available while the spaces are listed after a failed deletion', async () => {
    store.deleteUserWithTransfers.mockRejectedValue(new Error('boom'));
    await renderModal();
    await click(destructive());
    await flush();
    await click(getByRole('button', 'Cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('shows "Failed to delete user" when the server refuses, stays open and is not reported as a success', async () => {
    store.deleteUserWithTransfers.mockRejectedValue(new Error('This user still owns servers'));
    await renderModal();
    await click(destructive());
    await flush();
    expect(toast.error).toHaveBeenCalledWith('Failed to delete user');
    expect(toast.success).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(getByRole('heading', 'Delete alice')).toBeTruthy();
  });

  it('shows the reason the server gave when the response carries one', async () => {
    store.deleteUserWithTransfers.mockRejectedValue(refusal({ error: 'Cannot delete the last superadmin' }));
    await renderModal();
    await click(destructive());
    await flush();
    expect(toast.error).toHaveBeenCalledWith('Cannot delete the last superadmin');
    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  it('falls back to the fixed sentence when the response carries no reason', async () => {
    store.deleteUserWithTransfers.mockRejectedValue(refusal({}));
    await renderModal();
    await click(destructive());
    await flush();
    expect(toast.error).toHaveBeenCalledWith('Failed to delete user');
  });

  it('labels each heir select so it is found by name, one per space', async () => {
    const second = owned({ id: 's-7', name: 'Other', members: [member('m-9', 'admin')] });
    await renderModal([RAID, second]);
    expect(queryAllByRole('combobox', 'Transfer ownership to:')).toHaveLength(2);
    const ids = heirSelects().map((s) => s.id);
    expect(new Set(ids).size).toBe(2);
  });

  it('lets the admin try again after a refusal, with the choices that were made kept', async () => {
    store.deleteUserWithTransfers.mockRejectedValueOnce(new Error('boom'));
    await renderModal();
    await choose(heirSelects()[0], 'm-3');
    await click(destructive());
    await flush();
    expect(destructive().disabled).toBe(false);
    expect(destructive().textContent).toBe('Confirm & Delete User');
    await click(destructive());
    await flush();
    expect(store.deleteUserWithTransfers).toHaveBeenCalledTimes(2);
    expect(store.deleteUserWithTransfers).toHaveBeenLastCalledWith('u-9', [{ serverId: 's-1', action: 'transfer', newOwnerId: 'm-3' }]);
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it('cannot be triggered twice while the request is in flight', async () => {
    const pending = deferred();
    store.deleteUserWithTransfers.mockReturnValue(pending.promise);
    await renderModal();
    await click(destructive());
    expect(destructive().textContent).toBe('Deleting...');
    expect(destructive().disabled).toBe(true);
    await click(destructive());
    await click(destructive());
    expect(store.deleteUserWithTransfers).toHaveBeenCalledTimes(1);

    pending.resolve();
    await flush();
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });
});
