import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { mount, click, deferred, getByRole, queryByRole, queryAllByRole, bodyText, flush, type Mounted } from '../helpers/dom';

/**
 * The feature-flag switchboard: it shows what the server lists, flips a flag
 * with the opposite of the state on screen, and never keeps a state of its
 * own (the shown state is whatever the store holds after the server answers).
 */

interface Flag { name: string; label: string; description: string; enabled: boolean; isCustom: boolean }

const store = vi.hoisted(() => ({
  featureFlags: [] as Array<{ name: string; label: string; description: string; enabled: boolean; isCustom: boolean }>,
  fetchFeatureFlags: vi.fn(),
  updateFeatureFlag: vi.fn(),
  resetFeatureFlag: vi.fn(),
}));
vi.mock('../../stores/adminStore', () => ({ useAdminStore: Object.assign(() => store, { getState: () => store }) }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('../../stores/toastStore', () => ({ toast }));

import { AdminFeatureFlags } from '../../components/AdminFeatureFlags';

const WEBHOOKS: Flag = { name: 'webhooks', label: 'Incoming webhooks', description: 'Lets spaces post through webhooks.', enabled: true, isCustom: false };
const DISCOVERY: Flag = { name: 'server_discovery', label: 'Server discovery', description: 'Explore directory.', enabled: false, isCustom: true };

let view: Mounted;

async function renderFlags() {
  await view.render(<AdminFeatureFlags />);
}
// A flag's card: the one bordered box that holds its label.
const rowOf = (label: string) => Array.from(document.body.querySelectorAll('div')).find(
  (d) => d.className.includes('rounded-lg') && d.textContent?.includes(label),
);
const toggleIn = (label: string) => rowOf(label)!.querySelector('button[title^="Click to"]') as HTMLButtonElement;

beforeEach(() => {
  vi.clearAllMocks();
  store.featureFlags = [{ ...WEBHOOKS }, { ...DISCOVERY }];
  store.fetchFeatureFlags.mockResolvedValue(undefined);
  store.updateFeatureFlag.mockResolvedValue(undefined);
  store.resetFeatureFlag.mockResolvedValue(undefined);
  view = mount();
});
afterEach(() => view.unmount());

describe('AdminFeatureFlags — what it shows', () => {
  it('loads the flags when it opens', async () => {
    await renderFlags();
    expect(store.fetchFeatureFlags).toHaveBeenCalledTimes(1);
  });

  it('shows each flag the server lists with its label and its name', async () => {
    await renderFlags();
    expect(bodyText()).toContain('Incoming webhooks');
    expect(bodyText()).toContain('webhooks');
    expect(bodyText()).toContain('Server discovery');
    expect(bodyText()).toContain('server_discovery');
  });

  it('shows each flag as enabled or disabled through its toggle: "Click to disable" for an enabled one, "Click to enable" for a disabled one', async () => {
    await renderFlags();
    expect(toggleIn('Incoming webhooks').title).toBe('Click to disable');
    expect(toggleIn('Server discovery').title).toBe('Click to enable');
  });

  it('marks only an overridden flag as Custom and offers its reset', async () => {
    await renderFlags();
    expect(rowOf('Server discovery')!.textContent).toContain('Custom');
    expect(rowOf('Incoming webhooks')!.textContent).not.toContain('Custom');
    expect(queryAllByRole('button', 'Reset to default')).toHaveLength(1);
  });

  it('shows the description in a tooltip when the pointer is over the help icon', async () => {
    await renderFlags();
    expect(bodyText()).not.toContain('Lets spaces post through webhooks.');
    const help = rowOf('Incoming webhooks')!.querySelector('span.cursor-help')!;
    await act(async () => { help.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); });
    expect(bodyText()).toContain('Lets spaces post through webhooks.');
    await act(async () => { help.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })); });
    expect(bodyText()).not.toContain('Lets spaces post through webhooks.');
  });

  it('shows only the flags the server lists and invents none', async () => {
    store.featureFlags = [{ ...WEBHOOKS }];
    await renderFlags();
    expect(document.body.querySelectorAll('button[title^="Click to"]')).toHaveLength(1);
    expect(bodyText()).not.toContain('server_discovery');
    expect(bodyText()).not.toContain('bots');
    expect(bodyText()).not.toContain('Server discovery');
  });

  it('says it is loading while the list is empty', async () => {
    store.featureFlags = [];
    await renderFlags();
    expect(bodyText()).toContain('Loading feature flags...');
    expect(document.body.querySelectorAll('button[title^="Click to"]')).toHaveLength(0);
  });
});

describe('AdminFeatureFlags — toggling', () => {
  it('turns an enabled flag off by sending its name and false', async () => {
    await renderFlags();
    await click(toggleIn('Incoming webhooks'));
    await flush();
    expect(store.updateFeatureFlag).toHaveBeenCalledTimes(1);
    expect(store.updateFeatureFlag).toHaveBeenCalledWith('webhooks', false);
    expect(toast.success).toHaveBeenCalledWith('Feature "webhooks" disabled');
  });

  it('turns a disabled flag on by sending its name and true', async () => {
    await renderFlags();
    await click(toggleIn('Server discovery'));
    await flush();
    expect(store.updateFeatureFlag).toHaveBeenCalledTimes(1);
    expect(store.updateFeatureFlag).toHaveBeenCalledWith('server_discovery', true);
    expect(toast.success).toHaveBeenCalledWith('Feature "server_discovery" enabled');
  });

  it('touches only the flag that was clicked', async () => {
    await renderFlags();
    await click(toggleIn('Server discovery'));
    await flush();
    expect(store.updateFeatureFlag.mock.calls.map((c) => c[0])).toEqual(['server_discovery']);
    expect(store.resetFeatureFlag).not.toHaveBeenCalled();
  });

  it('sends the state the screen shows, inverted, after the store has changed it', async () => {
    await renderFlags();
    await click(toggleIn('Incoming webhooks'));
    await flush();
    store.featureFlags = [{ ...WEBHOOKS, enabled: false }, { ...DISCOVERY }];
    await renderFlags();
    expect(toggleIn('Incoming webhooks').title).toBe('Click to enable');
    await click(toggleIn('Incoming webhooks'));
    await flush();
    expect(store.updateFeatureFlag).toHaveBeenLastCalledWith('webhooks', true);
  });

  it('disables that flag\'s switch while the request runs, so a second press sends nothing, and frees it afterwards', async () => {
    const pending = deferred();
    store.updateFeatureFlag.mockReturnValue(pending.promise);
    await renderFlags();
    await click(toggleIn('Incoming webhooks'));
    expect(toggleIn('Incoming webhooks').disabled).toBe(true);
    expect(toggleIn('Server discovery').disabled).toBe(false);
    await click(toggleIn('Incoming webhooks'));
    expect(store.updateFeatureFlag).toHaveBeenCalledTimes(1);
    pending.resolve();
    await flush();
    expect(toggleIn('Incoming webhooks').disabled).toBe(false);
  });

  it('when the update fails, shows the error, reports no success and leaves the flag as the store has it', async () => {
    store.updateFeatureFlag.mockRejectedValue(new Error('boom'));
    await renderFlags();
    await click(toggleIn('Incoming webhooks'));
    await flush();
    expect(toast.error).toHaveBeenCalledWith('Failed to update feature flag');
    expect(toast.success).not.toHaveBeenCalled();
    expect(toggleIn('Incoming webhooks').title).toBe('Click to disable');
    expect(toggleIn('Incoming webhooks').disabled).toBe(false);
    expect(store.featureFlags[0].enabled).toBe(true);
  });
});

describe('AdminFeatureFlags — reset', () => {
  it('resets an overridden flag by its name', async () => {
    await renderFlags();
    await click(getByRole('button', 'Reset to default'));
    await flush();
    expect(store.resetFeatureFlag).toHaveBeenCalledTimes(1);
    expect(store.resetFeatureFlag).toHaveBeenCalledWith('server_discovery');
    expect(toast.success).toHaveBeenCalledWith('Feature "server_discovery" reset to default');
    expect(store.updateFeatureFlag).not.toHaveBeenCalled();
  });

  it('shows "Failed to reset feature flag" when the reset fails', async () => {
    store.resetFeatureFlag.mockRejectedValue(new Error('boom'));
    await renderFlags();
    await click(getByRole('button', 'Reset to default'));
    await flush();
    expect(toast.error).toHaveBeenCalledWith('Failed to reset feature flag');
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('offers no reset on a flag that is at its default', async () => {
    store.featureFlags = [{ ...WEBHOOKS }];
    await renderFlags();
    expect(queryByRole('button', 'Reset to default')).toBeNull();
  });
});
