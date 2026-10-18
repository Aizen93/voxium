import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AdminWebhook } from '@voxium/shared';

/**
 * The admin's webhooks modal for one server: the list (every webhook, with
 * its channel, creator and dates), Disable / Enable and Delete (with an
 * opt-in purge of its messages), each behind a confirm; loading, empty and
 * error states.
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
    createdBy: { id: 'u-1', username: 'alice', displayName: 'Alice' },
    createdAt: '2026-10-18T10:00:00.000Z', lastUsedAt: null, channelName: 'general', ...over,
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

  it('Disable opens a danger confirm naming the webhook (403 until re-enabled, the owner can re-enable) and sends nothing yet', async () => {
    await render();
    await clickIn('CI', 'webhook-disable');
    expect(store.setServerWebhookEnabled).not.toHaveBeenCalled();
    const body = toggleConfirm()!.textContent!;
    expect(body).toContain('"CI"');
    expect(body).toContain('403 until it is re-enabled');
    expect(body).toContain('The server owner can re-enable it');
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
