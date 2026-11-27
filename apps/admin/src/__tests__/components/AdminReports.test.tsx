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

describe('AdminReports — resolving and dismissing', () => {
  const rowButton = (text: string) => qa('tbody tr button').find((b) => b.textContent?.trim() === text && rowWith('Offensive listing').contains(b)) as HTMLButtonElement;

  it('Resolve sends the report and closes the modal once the store reports success', async () => {
    store.resolveReport.mockResolvedValue(true);
    await render();
    await act(async () => { rowButton('Resolve').click(); });
    await act(async () => { buttonByText('Resolve').click(); });
    expect(store.resolveReport).toHaveBeenCalledWith('r-server', { resolution: 'Resolved' });
    expect(buttonByText('Resolve')).toBeUndefined();
  });

  it('the Resolve dialog keeps a typed note and a ticked box through Escape and a click on the backdrop', async () => {
    await render();
    await act(async () => { rowButton('Resolve').click(); });
    const note = qa('.fixed textarea')[0] as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(note, 'Owner warned, listing edited');
      note.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const ban = qa('.fixed input[type="checkbox"]')[0] as HTMLInputElement;
    await act(async () => { ban.click(); });
    expect(ban.checked).toBe(true);

    await act(async () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    const backdrop = qa('.fixed').find((el) => el.querySelector('[role="dialog"]'))!;
    await act(async () => {
      backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      backdrop.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect((qa('.fixed textarea')[0] as HTMLTextAreaElement).value).toBe('Owner warned, listing edited');
    expect((qa('.fixed input[type="checkbox"]')[0] as HTMLInputElement).checked).toBe(true);
    expect(store.resolveReport).not.toHaveBeenCalled();
    // Cancel still closes it and discards the draft
    await act(async () => { buttonByText('Cancel').click(); });
    expect(qa('.fixed textarea')).toHaveLength(0);
  });

  it('Resolve keeps the modal open for another try when the store reports a failure', async () => {
    store.resolveReport.mockResolvedValue(false);
    await render();
    await act(async () => { rowButton('Resolve').click(); });
    await act(async () => { buttonByText('Resolve').click(); });
    expect(store.resolveReport).toHaveBeenCalledTimes(1);
    expect(buttonByText('Resolve')).toBeDefined();
    expect((buttonByText('Resolve') as HTMLButtonElement).disabled).toBe(false);
  });

  it('Dismiss closes the modal on success and keeps it open on failure', async () => {
    store.dismissReport.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await render();
    await act(async () => { rowButton('Dismiss').click(); });
    await act(async () => { buttonByText('Dismiss').click(); });
    expect(buttonByText('Dismiss')).toBeDefined();
    await act(async () => { buttonByText('Dismiss').click(); });
    expect(store.dismissReport).toHaveBeenCalledTimes(2);
    expect(buttonByText('Dismiss')).toBeUndefined();
  });
});

// ─── Reports kept after an account's deletion (#48) ─────────────────────────

describe('AdminReports — a report that outlives a deleted account', () => {
  const EXPIRES = '2027-11-20T08:00:00.000Z';
  const KEPT_ABOUT = report({
    id: 'r-kept', reason: 'Threats in a space', reportedUserId: null, reportedUsername: 'gone-user',
    reportedUserDeletedAt: '2026-11-20T08:00:00.000Z', expiresAt: EXPIRES,
  });
  const KEPT_BY = report({
    id: 'r-by', reason: 'Spam from a bot', reporterId: null, reporterUsername: null,
    reporterDeletedAt: '2026-11-21T08:00:00.000Z', expiresAt: '2027-11-21T08:00:00.000Z',
  });
  const LIVE = report({ id: 'r-live', reason: 'Ordinary case' });
  const resolveOf = (reason: string) =>
    Array.from(rowWith(reason).querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Resolve') as HTMLButtonElement;

  beforeEach(() => {
    store.reports = [KEPT_ABOUT, KEPT_BY, LIVE];
    store.reportsTotal = 3;
  });

  it('a deleted reported account is shown by its kept username, marked "Deleted account", with the date the report will be deleted', async () => {
    await render();
    const row = rowWith('Threats in a space');

    expect(row.textContent).toContain('gone-user');
    expect(row.querySelector('[data-testid="report-reported-deleted"]')!.textContent).toBe('Deleted account');
    expect(row.querySelector('[data-testid="report-expires"]')!.textContent).toBe(`Will be deleted on ${new Date(EXPIRES).toLocaleDateString()}`);
    // the reporter is alive and named
    expect(row.textContent).toContain('reporter');
    expect(row.querySelector('[data-testid="report-reporter-deleted"]')).toBeNull();
  });

  it('a deleted reporter is shown as "Deleted account"', async () => {
    await render();
    const row = rowWith('Spam from a bot');

    expect(row.querySelector('[data-testid="report-reporter-deleted"]')!.textContent).toBe('Deleted account');
    expect(row.querySelector('[data-testid="report-reported-deleted"]')).toBeNull();
    expect(row.querySelector('[data-testid="report-expires"]')).not.toBeNull();
  });

  it('a report whose accounts both live shows no mark and no date', async () => {
    await render();
    const row = rowWith('Ordinary case');

    expect(row.querySelector('[data-testid="report-reporter-deleted"]')).toBeNull();
    expect(row.querySelector('[data-testid="report-reported-deleted"]')).toBeNull();
    expect(row.querySelector('[data-testid="report-expires"]')).toBeNull();
  });

  it('the resolve dialog of a report about a deleted account offers NO ban, says why, and resolves without one', async () => {
    store.resolveReport.mockResolvedValue(true);
    await render();
    await act(async () => { resolveOf('Threats in a space').click(); });

    expect(document.body.textContent).toContain('Reported user: gone-user (deleted account)');
    expect(qa('.fixed input[type="checkbox"]')).toHaveLength(0);
    expect(document.body.textContent).not.toContain('Ban reported user');
    expect(qa('[data-testid="report-ban-unavailable"]')[0].textContent).toBe(
      `The reported account has been deleted, so there is no one to ban. This report will be deleted on ${new Date(EXPIRES).toLocaleDateString()}.`,
    );
    expect(buttonByText('Resolve & Ban')).toBeUndefined();

    await act(async () => { buttonByText('Resolve').click(); });
    expect(store.resolveReport).toHaveBeenCalledWith('r-kept', { resolution: 'Resolved' });
  });

  it('the resolve dialog stays a dialog that keeps its typed note through Escape and the backdrop', async () => {
    await render();
    await act(async () => { resolveOf('Threats in a space').click(); });
    const note = qa('.fixed textarea')[0] as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(note, 'Kept for the record');
      note.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await act(async () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });

    expect((qa('.fixed textarea')[0] as HTMLTextAreaElement).value).toBe('Kept for the record');
  });

  it('a report BY a deleted account keeps its ban control (the reported account lives)', async () => {
    await render();
    await act(async () => { resolveOf('Spam from a bot').click(); });

    expect(qa('.fixed input[type="checkbox"]')).toHaveLength(1);
    expect(document.body.textContent).toContain('Ban reported user');
    expect(qa('[data-testid="report-ban-unavailable"]')).toHaveLength(0);
  });

  it('a refusal the store reports keeps the dialog open for another try', async () => {
    store.resolveReport.mockResolvedValue(false);
    await render();
    await act(async () => { resolveOf('Threats in a space').click(); });
    await act(async () => { buttonByText('Resolve').click(); });

    expect(buttonByText('Resolve')).toBeDefined();
  });

  it('a reported account deleted while the dialog is open with the ban ticked: the dialog follows the list, the ban box goes, and no ban is sent', async () => {
    store.resolveReport.mockResolvedValue(true);
    await render();
    await act(async () => { resolveOf('Ordinary case').click(); });
    const ban = qa('.fixed input[type="checkbox"]')[0] as HTMLInputElement;
    await act(async () => { ban.click(); });
    expect(buttonByText('Resolve & Ban')).toBeDefined();

    // the list refreshes (a report:new) with the reported account now deleted
    store.reports = [KEPT_ABOUT, KEPT_BY, { ...LIVE, reportedUserId: null, reportedUserDeletedAt: '2026-11-22T08:00:00.000Z', expiresAt: '2027-11-22T08:00:00.000Z' }];
    await render();

    expect(qa('.fixed input[type="checkbox"]')).toHaveLength(0);
    expect(qa('[data-testid="report-ban-unavailable"]')).toHaveLength(1);
    await act(async () => { buttonByText('Resolve').click(); });
    expect(store.resolveReport).toHaveBeenCalledWith('r-live', { resolution: 'Resolved' });
  });

  it('a message link that goes while the dialog is open with the delete box ticked: the box goes, the label says Resolve, and no delete is sent', async () => {
    const ABOUT_A_MESSAGE = report({ id: 'r-msg-live', type: 'message', messageId: 'm-9', messageContent: 'hi', reason: 'Message case', reportedUsername: 'poster' });
    store.reports = [ABOUT_A_MESSAGE];
    store.resolveReport.mockResolvedValue(true);
    await render();
    await act(async () => { resolveOf('Message case').click(); });
    // the first box of a message report is "delete the reported message"
    const del = qa('.fixed input[type="checkbox"]')[0] as HTMLInputElement;
    await act(async () => { del.click(); });
    expect(buttonByText('Resolve & Delete')).toBeDefined();

    // the list refreshes with the message gone (its author's account was deleted, or the message was)
    store.reports = [{ ...ABOUT_A_MESSAGE, messageId: null }];
    await render();

    expect(buttonByText('Resolve & Delete')).toBeUndefined();
    await act(async () => { buttonByText('Resolve').click(); });
    expect(store.resolveReport).toHaveBeenCalledWith('r-msg-live', { resolution: 'Resolved' });
  });
});
