import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AdminWebhook } from '@voxium/shared';

/**
 * The admin's webhooks modal for one server: the list (every webhook, with
 * its channel, creator and dates), Disable / Enable and Delete (with an
 * opt-in purge of its messages), each behind a confirm; loading, empty and
 * error states; the admin lock, creator-removed and rotation marks.
 */

const store = vi.hoisted(() => ({
  serverWebhooks: [] as AdminWebhook[],
  serverWebhooksServerId: null as string | null,
  serverWebhooksLoading: false,
  serverWebhooksError: false,
  fetchServerWebhooks: vi.fn(),
  setServerWebhookEnabled: vi.fn(),
  deleteServerWebhook: vi.fn(),
}));
vi.mock('../../stores/adminStore', () => ({ useAdminStore: Object.assign(() => store, { getState: () => store }) }));

import { AdminServerWebhooksModal } from '../../components/AdminServerWebhooksModal';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function webhook(over: Partial<AdminWebhook>): AdminWebhook {
  return {
    id: 'wh-1', serverId: 'srv-1', channelId: 'ch-1', name: 'CI', type: 'generic', enabled: true,
    adminDisabledAt: null, creatorRemovedAt: null,
    createdBy: { id: 'u-1', username: 'alice', displayName: 'Alice' },
    createdAt: '2026-10-18T10:00:00.000Z', lastUsedAt: null, lastRotatedAt: null, lastRotatedBy: null,
    channelName: 'general', ...over,
  };
}
const CI = webhook({});
const DEPLOYS = webhook({
  id: 'wh-2', name: 'Deploys', type: 'github', enabled: false, channelId: 'ch-staff', channelName: 'staff-only',
  createdBy: null, lastUsedAt: '2026-10-18T11:30:00.000Z',
});

let container: HTMLDivElement;
let root: Root;
const onClose = vi.fn();
const q = (sel: string) => document.body.querySelector(sel) as HTMLElement | null;
const qa = (sel: string) => Array.from(document.body.querySelectorAll(sel)) as HTMLElement[];
const rows = () => qa('[data-testid="server-webhook-row"]');
const rowNamed = (name: string) => rows().find((r) => r.textContent?.includes(name))!;
const buttonByText = (text: string) => qa('button').find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;
const toggleConfirm = () => q('[data-testid="webhook-toggle-confirm"]');
const clickIn = async (name: string, testId: string) => {
  await act(async () => { (rowNamed(name).querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement).click(); });
};
const clickButton = async (text: string) => {
  await act(async () => { buttonByText(text)!.click(); });
};

async function render(serverId = 'srv-1') {
  await act(async () => { root.render(<AdminServerWebhooksModal serverId={serverId} serverName="Raid Night" onClose={onClose} />); });
}

beforeEach(() => {
  vi.clearAllMocks();
  store.serverWebhooks = [CI, DEPLOYS];
  store.serverWebhooksServerId = 'srv-1';
  store.serverWebhooksLoading = false;
  store.serverWebhooksError = false;
  store.setServerWebhookEnabled.mockResolvedValue(undefined);
  store.deleteServerWebhook.mockResolvedValue(undefined);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('AdminServerWebhooksModal — list', () => {
  it('fetches the server on open and renders one row per webhook', async () => {
    await render();
    expect(store.fetchServerWebhooks).toHaveBeenCalledWith('srv-1');
    expect(q('[data-testid="server-webhooks-modal"]')!.textContent).toContain('Raid Night');
    expect(rows()).toHaveLength(2);

    const ci = rowNamed('CI');
    expect(ci.textContent).toContain('Generic');
    expect(ci.textContent).toContain('#general');
    expect(ci.textContent).toContain('ch-1');
    expect(ci.textContent).toContain('alice');
    expect(ci.textContent).toContain('Never'); // never used
    expect(ci.querySelector('[data-testid="webhook-status"]')!.textContent).toBe('Enabled');
    expect(ci.querySelector('[data-testid="webhook-disable"]')).not.toBeNull();

    const deploys = rowNamed('Deploys');
    expect(deploys.textContent).toContain('GitHub');
    expect(deploys.textContent).toContain('#staff-only');
    expect(deploys.textContent).toContain('Deleted user');
    expect(deploys.textContent).not.toContain('Never');
    expect(deploys.querySelector('[data-testid="webhook-status"]')!.textContent).toBe('Disabled');
    expect(deploys.querySelector('[data-testid="webhook-enable"]')).not.toBeNull();
  });

  it('a channel without a name (secure, never expected) shows its id only', async () => {
    store.serverWebhooks = [webhook({ channelId: 'ch-sec', channelName: null })];
    await render();
    expect(rowNamed('CI').textContent).toContain('ch-sec');
    expect(rowNamed('CI').textContent).not.toContain('#');
  });

  it('never shows rows of another server (a previous opening)', async () => {
    store.serverWebhooksServerId = 'srv-other';
    await render();
    expect(rows()).toHaveLength(0);
    expect(store.fetchServerWebhooks).toHaveBeenCalledWith('srv-1');
  });

  it('loading: a spinner, no empty-state text', async () => {
    store.serverWebhooks = [];
    store.serverWebhooksLoading = true;
    await render();
    expect(q('[data-testid="server-webhooks-loading"]')).not.toBeNull();
    expect(q('[data-testid="server-webhooks-empty"]')).toBeNull();
  });

  it('a refetch keeps the rows on screen (no spinner flash)', async () => {
    store.serverWebhooksLoading = true;
    await render();
    expect(rows()).toHaveLength(2);
    expect(q('[data-testid="server-webhooks-loading"]')).toBeNull();
  });

  it('empty: says the server has none', async () => {
    store.serverWebhooks = [];
    await render();
    expect(q('[data-testid="server-webhooks-empty"]')!.textContent).toContain('no webhooks');
  });

  it('error: says so and Retry refetches', async () => {
    store.serverWebhooks = [];
    store.serverWebhooksError = true;
    await render();
    expect(q('[data-testid="server-webhooks-error"]')).not.toBeNull();
    expect(q('[data-testid="server-webhooks-empty"]')).toBeNull();
    await act(async () => { buttonByText('Retry')!.click(); });
    expect(store.fetchServerWebhooks).toHaveBeenCalledTimes(2);
    expect(store.fetchServerWebhooks).toHaveBeenLastCalledWith('srv-1');
  });

  it('Close calls onClose', async () => {
    await render();
    await act(async () => { buttonByText('Close')!.click(); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('AdminServerWebhooksModal — actions', () => {
  it('Disable / Enable send the opposite of the current state, once confirmed', async () => {
    await render();
    await clickIn('CI', 'webhook-disable');
    await clickButton('Disable Webhook');
    expect(store.setServerWebhookEnabled).toHaveBeenLastCalledWith('wh-1', false);
    await clickIn('Deploys', 'webhook-enable');
    await clickButton('Enable Webhook');
    expect(store.setServerWebhookEnabled).toHaveBeenLastCalledWith('wh-2', true);
  });

  it('Disable opens a danger confirm naming the webhook (403 until re-enabled, a lock the owner cannot lift) and sends nothing yet', async () => {
    await render();
    await clickIn('CI', 'webhook-disable');
    expect(store.setServerWebhookEnabled).not.toHaveBeenCalled();
    const body = toggleConfirm()!.textContent!;
    expect(body).toContain('"CI"');
    expect(body).toContain('403 until it is re-enabled');
    // the admin disable is sticky: promising the owner a re-enable would be false
    expect(body).toContain('The server owner cannot re-enable it');
    expect(body).not.toContain('The server owner can re-enable it');
    expect(buttonByText('Disable Webhook')!.className).toContain('bg-vox-accent-danger');

    await clickButton('Disable Webhook');
    expect(store.setServerWebhookEnabled).toHaveBeenCalledTimes(1);
    expect(store.setServerWebhookEnabled).toHaveBeenCalledWith('wh-1', false);
    // the confirm closes
    expect(toggleConfirm()).toBeNull();
  });

  it('Enable opens a primary confirm naming the webhook; confirming enables it', async () => {
    await render();
    await clickIn('Deploys', 'webhook-enable');
    expect(store.setServerWebhookEnabled).not.toHaveBeenCalled();
    const body = toggleConfirm()!.textContent!;
    expect(body).toContain('"Deploys"');
    expect(body).not.toContain('403');
    const confirm = buttonByText('Enable Webhook')!;
    expect(confirm.className).toContain('bg-vox-accent-primary');
    expect(confirm.className).not.toContain('bg-vox-accent-danger');

    await clickButton('Enable Webhook');
    expect(store.setServerWebhookEnabled).toHaveBeenCalledTimes(1);
    expect(store.setServerWebhookEnabled).toHaveBeenCalledWith('wh-2', true);
    expect(toggleConfirm()).toBeNull();
  });

  it('Cancel on the toggle confirm changes nothing and closes it', async () => {
    await render();
    await clickIn('CI', 'webhook-disable');
    await clickButton('Cancel');
    expect(toggleConfirm()).toBeNull();
    await clickIn('Deploys', 'webhook-enable');
    await clickButton('Cancel');
    expect(toggleConfirm()).toBeNull();
    expect(store.setServerWebhookEnabled).not.toHaveBeenCalled();
  });

  it('the toggle is disabled while its request runs', async () => {
    let resolve!: () => void;
    store.setServerWebhookEnabled.mockImplementationOnce(() => new Promise<void>((r) => { resolve = r; }));
    await render();
    const button = rowNamed('CI').querySelector('[data-testid="webhook-disable"]') as HTMLButtonElement;
    await act(async () => { button.click(); });
    await clickButton('Disable Webhook');
    expect(button.disabled).toBe(true);
    await act(async () => { resolve(); });
    expect((rowNamed('CI').querySelector('[data-testid="webhook-disable"]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('Delete confirms by name and, by default, keeps the messages (purge false)', async () => {
    await render();
    await act(async () => { (rowNamed('Deploys').querySelector('[data-testid="webhook-delete"]') as HTMLButtonElement).click(); });
    expect(document.body.textContent).toContain('"Deploys"');
    const box = q('[data-testid="webhook-delete-purge"]') as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(document.body.textContent).toContain('Its messages stay');

    await act(async () => { buttonByText('Delete Webhook')!.click(); });
    expect(store.deleteServerWebhook).toHaveBeenCalledWith('wh-2', false);
    // the confirm closes
    expect(q('[data-testid="webhook-delete-purge"]')).toBeNull();
  });

  it('"Also delete its messages" sends purge true', async () => {
    await render();
    await act(async () => { (rowNamed('CI').querySelector('[data-testid="webhook-delete"]') as HTMLButtonElement).click(); });
    await act(async () => { (q('[data-testid="webhook-delete-purge"]') as HTMLInputElement).click(); });
    expect(document.body.textContent).toContain('Every message it posted, in every channel');
    await act(async () => { buttonByText('Delete Webhook')!.click(); });
    expect(store.deleteServerWebhook).toHaveBeenCalledWith('wh-1', true);
  });

  it('the purge box starts unticked on every opening, and Cancel deletes nothing', async () => {
    await render();
    await act(async () => { (rowNamed('CI').querySelector('[data-testid="webhook-delete"]') as HTMLButtonElement).click(); });
    await act(async () => { (q('[data-testid="webhook-delete-purge"]') as HTMLInputElement).click(); });
    await act(async () => { buttonByText('Cancel')!.click(); });
    expect(store.deleteServerWebhook).not.toHaveBeenCalled();

    await act(async () => { (rowNamed('CI').querySelector('[data-testid="webhook-delete"]') as HTMLButtonElement).click(); });
    expect((q('[data-testid="webhook-delete-purge"]') as HTMLInputElement).checked).toBe(false);
  });
});

describe('AdminServerWebhooksModal — admin lock, creator removal, rotation', () => {
  const LOCKED_AT = '2026-10-19T08:00:00.000Z';
  const REMOVED_AT = '2026-10-19T09:15:00.000Z';
  const ROTATED_AT = '2026-10-19T10:30:00.000Z';
  const when = (iso: string) => new Date(iso).toLocaleString();
  const LOCKED = webhook({ id: 'wh-3', name: 'Alerts', enabled: false, adminDisabledAt: LOCKED_AT });
  const ORPHANED = webhook({ id: 'wh-4', name: 'Builds', enabled: false, creatorRemovedAt: REMOVED_AT });
  const badge = (name: string, testId: string) => rowNamed(name).querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;

  it('an admin-disabled row says so, with the date of the lock in the title', async () => {
    store.serverWebhooks = [LOCKED, DEPLOYS];
    await render();
    const lock = badge('Alerts', 'webhook-admin-disabled')!;
    expect(lock.textContent).toBe('Admin-disabled');
    expect(lock.title).toContain(when(LOCKED_AT));
    expect(lock.title).toContain('the owner cannot re-enable it');
    expect(badge('Alerts', 'webhook-status')!.textContent).toBe('Disabled');
    // a webhook its owner disabled carries no lock
    expect(badge('Deploys', 'webhook-admin-disabled')).toBeNull();
  });

  it('a webhook a kick disabled says "URL holder removed", with the date in the title', async () => {
    store.serverWebhooks = [ORPHANED, CI];
    await render();
    const mark = badge('Builds', 'webhook-creator-removed')!;
    expect(mark.textContent).toBe('URL holder removed');
    expect(mark.title).toContain(when(REMOVED_AT));
    expect(badge('Builds', 'webhook-admin-disabled')).toBeNull();
    expect(badge('CI', 'webhook-creator-removed')).toBeNull();
  });

  it('a rotated webhook says when and by whom; a vanished rotator leaves the date; never rotated, nothing', async () => {
    store.serverWebhooks = [
      webhook({ id: 'wh-5', name: 'Rotated', lastRotatedAt: ROTATED_AT, lastRotatedBy: { id: 'u-2', username: 'bob', displayName: 'Bob the Owner' } }),
      webhook({ id: 'wh-6', name: 'Orphan rotation', lastRotatedAt: ROTATED_AT, lastRotatedBy: null }),
      CI,
    ];
    await render();
    expect(badge('Rotated', 'webhook-rotated')!.textContent).toBe(`Rotated ${when(ROTATED_AT)} by Bob the Owner`);
    expect(badge('Orphan rotation', 'webhook-rotated')!.textContent).toBe(`Rotated ${when(ROTATED_AT)}`);
    expect(badge('CI', 'webhook-rotated')).toBeNull();
  });

  it('Enable on an admin-locked row says it lifts the lock; confirming sends the same enable', async () => {
    store.serverWebhooks = [LOCKED, DEPLOYS];
    await render();
    const lifted = badge('Alerts', 'webhook-enable') as HTMLButtonElement;
    expect(lifted.title).toBe('Enable webhook (lifts the admin lock)');
    expect((badge('Deploys', 'webhook-enable') as HTMLButtonElement).title).toBe('Enable webhook');

    await clickIn('Alerts', 'webhook-enable');
    expect(toggleConfirm()!.textContent).toContain('This lifts the admin lock');
    await clickButton('Enable Webhook');
    expect(store.setServerWebhookEnabled).toHaveBeenCalledTimes(1);
    expect(store.setServerWebhookEnabled).toHaveBeenCalledWith('wh-3', true);
  });

  it('the Enable confirm of an unlocked row mentions no lock; a creator-removed row points at a rotation', async () => {
    store.serverWebhooks = [ORPHANED, DEPLOYS];
    await render();
    await clickIn('Deploys', 'webhook-enable');
    expect(toggleConfirm()!.textContent).not.toContain('admin lock');
    expect(toggleConfirm()!.textContent).not.toContain('rotate');
    await clickButton('Cancel');

    await clickIn('Builds', 'webhook-enable');
    const body = toggleConfirm()!.textContent!;
    expect(body).toContain('may still hold the URL');
    expect(body).toContain('rotate');
    expect(body).not.toContain('admin lock');
  });
});

describe('AdminServerWebhooksModal — Lock on a disabled, unlocked row', () => {
  const REMOVED_AT2 = '2026-10-19T08:00:00.000Z';
  const ORPHANED2 = webhook({ id: 'wh-7', name: 'Builds', enabled: false, creatorRemovedAt: REMOVED_AT2 });
  const LOCKED2 = webhook({ id: 'wh-8', name: 'Alerts', enabled: false, adminDisabledAt: REMOVED_AT2 });
  const badgeIn = (name: string, testId: string) => rowNamed(name).querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;

  it('offers Lock only where it adds something: a disabled row without the admin lock', async () => {
    store.serverWebhooks = [ORPHANED2, LOCKED2, CI];
    await render();
    expect(badgeIn('Builds', 'webhook-lock')).not.toBeNull();
    expect(badgeIn('Alerts', 'webhook-lock')).toBeNull();
    expect(badgeIn('CI', 'webhook-lock')).toBeNull();
    // Enable stays beside it
    expect(badgeIn('Builds', 'webhook-enable')).not.toBeNull();
  });

  it('confirming Lock sends { enabled: false } straight away: no Enable in between, the removal mark kept', async () => {
    store.serverWebhooks = [ORPHANED2];
    await render();
    await clickIn('Builds', 'webhook-lock');
    const body = q('[data-testid="webhook-lock-confirm"]')!.textContent!;
    expect(body).toContain('already disabled');
    expect(body).toContain('URL holder removed');
    await clickButton('Lock Webhook');
    expect(store.setServerWebhookEnabled).toHaveBeenCalledTimes(1);
    expect(store.setServerWebhookEnabled).toHaveBeenCalledWith('wh-7', false);
  });
});
