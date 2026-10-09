import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Server, ServerDiscoveryInfo } from '@voxium/shared';
import { DISCOVERY_TAGS, LIMITS } from '@voxium/shared';

/**
 * Server settings → Discovery: the owner's switches and card. Store state
 * only ever comes from server:updated, so the tab works on a draft and sends
 * exactly the fields that changed.
 */

// A STABLE t, like react-i18next's (the tab lists it in an effect dependency)
const t = (k: string) => k;
vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t }) };
});

const { updateDiscovery, fetchDiscoveryInfo, toastSuccess, toastError } = vi.hoisted(() => ({
  updateDiscovery: vi.fn(),
  fetchDiscoveryInfo: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

let server: Server;
vi.mock('../../stores/serverStore', () => {
  const state = () => ({ servers: [server], updateDiscovery, fetchDiscoveryInfo });
  const useServerStore = <T,>(sel: (s: ReturnType<typeof state>) => T) => sel(state());
  useServerStore.getState = state;
  return { useServerStore };
});
vi.mock('../../stores/toastStore', () => ({ toast: { success: toastSuccess, error: toastError, info: vi.fn(), warning: vi.fn() } }));

import { DiscoveryTab } from '../../components/server/DiscoveryTab';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const INFO: ServerDiscoveryInfo = {
  memberCount: 12, onlineCount: 3, weeklyMessages: 40, statsRefreshedAt: '2026-10-09T04:10:00.000Z',
  discoveryListed: true, discoveryBlockedAt: null, featuredAt: null,
};

let container: HTMLDivElement;
let root: Root;
const onGoToGeneral = vi.fn();

async function render() {
  await act(async () => { root.render(<DiscoveryTab serverId="srv-1" onGoToGeneral={onGoToGeneral} />); });
}
const q = (sel: string) => container.querySelector(sel) as HTMLElement | null;
const toggle = () => q('[data-testid="discovery-listed-toggle"]') as HTMLButtonElement;
const save = () => q('[data-testid="discovery-save"]') as HTMLButtonElement;
const setValue = (el: HTMLTextAreaElement | HTMLInputElement, value: string) => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};

beforeEach(() => {
  vi.clearAllMocks();
  server = {
    id: 'srv-1', name: 'Makhtofi Raiders', iconUrl: null, invitesLocked: false, ownerId: 'u-1', createdAt: '2026-01-01T00:00:00.000Z',
    description: null, tags: [], discoverable: true, joinMode: 'approval',
  };
  fetchDiscoveryInfo.mockResolvedValue(INFO);
  updateDiscovery.mockResolvedValue(undefined);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('DiscoveryTab', () => {
  it('starts from the server: listed on, approval mode, empty description with the nudge, no tags, save disabled', async () => {
    await render();
    expect(toggle().getAttribute('aria-checked')).toBe('true');
    expect((q('[data-testid="discovery-join-approval"]') as HTMLInputElement).checked).toBe(true);
    expect((q('[data-testid="discovery-description"]') as HTMLTextAreaElement).value).toBe('');
    expect(q('[data-testid="discovery-description-count"]')!.textContent).toBe(`0/${LIMITS.SERVER_DESCRIPTION_MAX}`);
    expect(container.textContent).toContain('discovery.settings.descriptionNudge');
    expect(save().disabled).toBe(true);
    expect(fetchDiscoveryInfo).toHaveBeenCalledWith('srv-1');
    // the preview IS the card, built from the draft
    expect(q('[data-testid="discovery-card-name"]')!.textContent).toBe('Makhtofi Raiders');
    expect(q('[data-testid="discovery-card-description"]')!.textContent).toBe('discovery.card.noDescription');
  });

  it('shows the activity line from the fetched info, with the last check', async () => {
    await render();
    const stats = q('[data-testid="discovery-stats"]')!.textContent!;
    expect(stats).toContain('discovery.settings.statsMembers');
    expect(stats).toContain('discovery.settings.statsRefreshedAt');
    expect(stats).toContain('discovery.settings.statsDaily');
    expect(stats).not.toContain('discovery.settings.statsNever');
  });

  it('says so when the figures were never computed', async () => {
    fetchDiscoveryInfo.mockResolvedValue({ ...INFO, statsRefreshedAt: null });
    await render();
    expect(q('[data-testid="discovery-stats"]')!.textContent).toContain('discovery.settings.statsNever');
  });

  it('a blocked server: the toggle is disabled and the administrator notice shows', async () => {
    fetchDiscoveryInfo.mockResolvedValue({ ...INFO, discoveryBlockedAt: '2026-10-08T00:00:00.000Z', discoveryListed: false });
    await render();
    expect(toggle().disabled).toBe(true);
    expect(q('[data-testid="discovery-blocked-notice"]')).not.toBeNull();
    expect(q('[data-testid="discovery-locked-notice"]')).toBeNull();
  });

  it('locked invites: the "hidden while locked" notice links to the General tab', async () => {
    server = { ...server, invitesLocked: true };
    await render();
    const notice = q('[data-testid="discovery-locked-notice"]')!;
    expect(notice.textContent).toContain('discovery.settings.hiddenInvitesLocked');
    act(() => { (notice.querySelector('button') as HTMLButtonElement).click(); });
    expect(onGoToGeneral).toHaveBeenCalledTimes(1);
  });

  it('the description counter follows the draft and the preview shows it', async () => {
    await render();
    await act(async () => { setValue(q('[data-testid="discovery-description"]') as HTMLTextAreaElement, 'EU-evening raid group.'); });
    expect(q('[data-testid="discovery-description-count"]')!.textContent).toBe(`22/${LIMITS.SERVER_DESCRIPTION_MAX}`);
    expect(q('[data-testid="discovery-card-description"]')!.textContent).toBe('EU-evening raid group.');
    expect(container.textContent).not.toContain('discovery.settings.descriptionNudge');
    expect(save().disabled).toBe(false);
  });

  it('caps the tag picker at five: the rest disable, unselecting re-enables', async () => {
    await render();
    for (const tag of DISCOVERY_TAGS.slice(0, LIMITS.DISCOVERY_MAX_TAGS)) {
      await act(async () => { q(`[data-testid="discovery-tag-${tag}"]`)!.click(); });
    }
    const sixth = q(`[data-testid="discovery-tag-${DISCOVERY_TAGS[5]}"]`) as HTMLButtonElement;
    expect(sixth.disabled).toBe(true);
    expect(q(`[data-testid="discovery-tag-${DISCOVERY_TAGS[0]}"]`)!.getAttribute('aria-pressed')).toBe('true');
    await act(async () => { q(`[data-testid="discovery-tag-${DISCOVERY_TAGS[0]}"]`)!.click(); });
    expect(sixth.disabled).toBe(false);
    // the preview prints the selected labels
    const printed = Array.from(container.querySelectorAll('[data-testid="discovery-card-tags"] span')).map((e) => e.textContent);
    expect(printed).toEqual(DISCOVERY_TAGS.slice(1, 5).map((t) => `discovery.tags.${t}`));
  });

  it('save sends ONLY the fields that changed, then toasts; the store is left to server:updated', async () => {
    await render();
    await act(async () => { q('[data-testid="discovery-join-open"]')!.click(); });
    await act(async () => { q('[data-testid="discovery-tag-gaming"]')!.click(); });
    await act(async () => { save().click(); });

    expect(updateDiscovery).toHaveBeenCalledTimes(1);
    expect(updateDiscovery).toHaveBeenCalledWith('srv-1', { joinMode: 'open', tags: ['gaming'] });
    expect(toastSuccess).toHaveBeenCalledWith('discovery.settings.saved');
  });

  it('hiding the server sends discoverable: false; clearing a description sends null', async () => {
    server = { ...server, description: 'Old text', tags: ['music'] };
    await render();
    await act(async () => { toggle().click(); });
    await act(async () => { setValue(q('[data-testid="discovery-description"]') as HTMLTextAreaElement, '   '); });
    await act(async () => { save().click(); });
    expect(updateDiscovery).toHaveBeenCalledWith('srv-1', { discoverable: false, description: null });
  });

  it('a rejected save toasts the translated error and keeps the draft', async () => {
    updateDiscovery.mockRejectedValue(new Error('Listing is disabled by an administrator'));
    await render();
    await act(async () => { toggle().click(); });
    await act(async () => { save().click(); });
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toggle().getAttribute('aria-checked')).toBe('false');
  });

  it('refuses a description with a bidi override locally, before any request', async () => {
    await render();
    await act(async () => { setValue(q('[data-testid="discovery-description"]') as HTMLTextAreaElement, `Free${String.fromCharCode(0x202e)}stuff`); });
    await act(async () => { save().click(); });
    expect(updateDiscovery).not.toHaveBeenCalled();
    // the shared validator's English string is mapped to a translated key
    expect(toastError).toHaveBeenCalledWith('serverErrors.descriptionUnsupportedChars');
  });

  it('a server:updated resyncs the UNTOUCHED drafts and leaves the touched one alone; a save clears the touched set', async () => {
    await render();
    await act(async () => { setValue(q('[data-testid="discovery-description"]') as HTMLTextAreaElement, 'Typing'); });
    // another moderator flipped the join mode and picked a tag meanwhile
    server = { ...server, joinMode: 'open', tags: ['music'] };
    await render();
    expect((q('[data-testid="discovery-join-open"]') as HTMLInputElement).checked).toBe(true);
    expect(q('[data-testid="discovery-tag-music"]')!.getAttribute('aria-pressed')).toBe('true');
    expect((q('[data-testid="discovery-description"]') as HTMLTextAreaElement).value).toBe('Typing');
    // so the save carries ONLY the description, against the updated store
    await act(async () => { save().click(); });
    expect(updateDiscovery).toHaveBeenCalledWith('srv-1', { description: 'Typing' });
    // the echo of our own save lands, then a later remote edit of the same
    // field: nothing is dirty any more, so the draft follows it
    server = { ...server, description: 'Typing' };
    await render();
    server = { ...server, description: 'Edited elsewhere' };
    await render();
    expect((q('[data-testid="discovery-description"]') as HTMLTextAreaElement).value).toBe('Edited elsewhere');
    expect(save().disabled).toBe(true);
  });

  it('a failed save keeps the touched fields touched: the next server:updated does not wipe the typing', async () => {
    updateDiscovery.mockRejectedValue(new Error('Listing is disabled by an administrator'));
    await render();
    await act(async () => { setValue(q('[data-testid="discovery-description"]') as HTMLTextAreaElement, 'Keep me'); });
    await act(async () => { save().click(); });
    expect(toastError).toHaveBeenCalledWith('serverErrors.listingDisabledByAdmin');
    server = { ...server, description: 'Remote' };
    await render();
    expect((q('[data-testid="discovery-description"]') as HTMLTextAreaElement).value).toBe('Keep me');
  });
});
