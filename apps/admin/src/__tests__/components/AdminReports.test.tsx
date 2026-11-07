import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AxiosError } from 'axios';
import type { Report } from '@voxium/shared';

/**
 * Server reports in the moderation queue: the row names the owner as the
 * reported user, "Show listing" reveals the name + description snapshot,
 * and the "Block from directory" shortcut hides the server without
 * resolving the report.
 */

const store = vi.hoisted(() => ({
  reports: [] as Report[],
  reportsTotal: 0,
  reportsPage: 1,
  reportsFilter: 'all',
  fetchReports: vi.fn(),
  setReportsFilter: vi.fn(),
  resolveReport: vi.fn(),
  dismissReport: vi.fn(),
  setServerDiscovery: vi.fn(),
  subscribeReports: vi.fn(),
  unsubscribeReports: vi.fn(),
}));
vi.mock('../../stores/adminStore', () => ({ useAdminStore: Object.assign(() => store, { getState: () => store }) }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('../../stores/toastStore', () => ({ toast }));

import { AdminReports } from '../../components/AdminReports';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function report(over: Partial<Report>): Report {
  return {
    id: 'r', type: 'user', status: 'pending', reason: 'spam', reporterId: 'u-1', reporterUsername: 'reporter',
    reportedUserId: 'u-2', reportedUsername: 'owner1', messageId: null, messageContent: null, contentSource: 'server',
    channelId: null, conversationId: null, serverId: null, resolvedById: null, resolvedByUsername: null, resolution: null,
    createdAt: '2026-10-11T00:00:00.000Z', resolvedAt: null, ...over,
  };
}
const SERVER_REPORT = report({ id: 'r-server', type: 'server', serverId: 'srv-1', messageContent: 'Raid Night\n\nEU evenings, no drama.', reason: 'Offensive listing' });
const MESSAGE_REPORT = report({ id: 'r-msg', type: 'message', messageId: 'm-1', messageContent: 'hello there', reason: 'Harassment', reportedUsername: 'poster' });
const RESOLVED_SERVER = report({ id: 'r-done', type: 'server', serverId: 'srv-2', status: 'resolved', messageContent: 'Old Hub', resolvedByUsername: 'adm', reason: 'Old' });

let container: HTMLDivElement;
let root: Root;
const qa = (sel: string) => Array.from(document.body.querySelectorAll(sel)) as HTMLElement[];
const rowWith = (text: string) => qa('tbody tr').find((tr) => tr.textContent?.includes(text))!;
// The confirm modal renders in a fixed overlay; the row's own "Block"
// shortcut has the same text, so confirm buttons are looked up inside it.
const buttonByText = (text: string) => qa('.fixed button').find((b) => b.textContent?.trim() === text) as HTMLButtonElement;

async function render() {
  await act(async () => { root.render(<AdminReports />); });
}

beforeEach(() => {
  vi.clearAllMocks();
  store.reports = [SERVER_REPORT, MESSAGE_REPORT, RESOLVED_SERVER];
  store.reportsTotal = 3;
  store.setServerDiscovery.mockResolvedValue({ id: 'srv-1', discoverable: false, discoveryListed: false, featuredAt: null, discoveryBlockedAt: 'now' });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('AdminReports — server reports', () => {
  it('renders the server row: type, the owner as the reported user, and the listing snapshot on demand', async () => {
    await render();
    const row = rowWith('Offensive listing');
    expect(row.textContent).toContain('server');
    expect(row.querySelector('[data-testid="report-owner-label"]')!.textContent).toBe('server owner');
    expect(row.textContent).toContain('owner1');
    const toggle = row.querySelector('[data-testid="report-toggle-content"]') as HTMLButtonElement;
    expect(toggle.textContent).toBe('Show listing');
    expect(row.querySelector('[data-testid="report-content"]')).toBeNull();
    await act(async () => { toggle.click(); });
    expect(rowWith('Offensive listing').textContent).toContain('Listing as reported');
    expect(rowWith('Offensive listing').querySelector('[data-testid="report-content"]')!.textContent).toBe('Raid Night\n\nEU evenings, no drama.');
    expect((rowWith('Offensive listing').querySelector('[data-testid="report-toggle-content"]') as HTMLButtonElement).textContent).toBe('Hide listing');

    // a message report keeps its wording and has no owner label
    const msgRow = rowWith('Harassment');
    expect(msgRow.querySelector('[data-testid="report-owner-label"]')).toBeNull();
    expect((msgRow.querySelector('[data-testid="report-toggle-content"]') as HTMLButtonElement).textContent).toBe('Show message');
  });

  it('offers "Block from directory" only on a PENDING server report', async () => {
    await render();
    expect(rowWith('Offensive listing').querySelector('[data-testid="report-block-server"]')).not.toBeNull();
    expect(rowWith('Harassment').querySelector('[data-testid="report-block-server"]')).toBeNull();
    expect(rowWith('Old').querySelector('[data-testid="report-block-server"]')).toBeNull();
  });

  it('Block → confirm names the listing → PATCH { blocked: true } → toast; the report stays open', async () => {
    await render();
    await act(async () => { (rowWith('Offensive listing').querySelector('[data-testid="report-block-server"]') as HTMLButtonElement).click(); });
    expect(document.body.textContent).toContain('Block from directory');
    expect(document.body.textContent).toContain('"Raid Night"');
    expect(document.body.textContent).toContain('The report stays open');
    await act(async () => { buttonByText('Block').click(); });
    expect(store.setServerDiscovery).toHaveBeenCalledWith('srv-1', { blocked: true });
    expect(toast.success).toHaveBeenCalledWith('Server blocked from the directory');
    expect(store.resolveReport).not.toHaveBeenCalled();
    expect(store.dismissReport).not.toHaveBeenCalled();
    expect(buttonByText('Block')).toBeUndefined();
  });

  it('a 404 says the server is gone; another refusal shows the server’s reason', async () => {
    const axiosErr = (status: number, error: string) => new AxiosError('Request failed', String(status), undefined, undefined, {
      status, statusText: '', headers: {}, config: {} as never, data: { success: false, error },
    });
    store.setServerDiscovery.mockRejectedValueOnce(axiosErr(404, 'Server not found'));
    await render();
    await act(async () => { (rowWith('Offensive listing').querySelector('[data-testid="report-block-server"]') as HTMLButtonElement).click(); });
    await act(async () => { buttonByText('Block').click(); });
    expect(toast.error).toHaveBeenCalledWith('That server no longer exists');

    store.setServerDiscovery.mockRejectedValueOnce(axiosErr(403, 'Admin access required'));
    await act(async () => { (rowWith('Offensive listing').querySelector('[data-testid="report-block-server"]') as HTMLButtonElement).click(); });
    await act(async () => { buttonByText('Block').click(); });
    expect(toast.error).toHaveBeenLastCalledWith('Admin access required');
  });

  it('the resolve modal of a server report names the server owner and explains the platform ban', async () => {
    await render();
    const resolve = Array.from(rowWith('Offensive listing').querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Resolve') as HTMLButtonElement;
    await act(async () => { resolve.click(); });
    expect(document.body.textContent).toContain('Server owner: owner1');
    expect(document.body.textContent).toContain('Ban the server owner');
    expect(document.body.textContent).not.toContain('Delete reported message');
  });
});
