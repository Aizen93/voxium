import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * The report modal's third target: a listed server (Explore's card menu).
 * The body carries the serverId and NO reportedUserId — the server resolves
 * the owner from the listing, so the client never names anyone.
 */

const t = (k: string) => k;
vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t }) };
});
vi.mock('../../services/api', () => ({ api: { post: vi.fn(), get: vi.fn() } }));
const T = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }));
vi.mock('../../stores/toastStore', () => ({ toast: T }));

import { api } from '../../services/api';
import { ReportModal } from '../../components/chat/ReportModal';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockPost = api.post as unknown as Mock;
let container: HTMLDivElement;
let root: Root;
const onClose = vi.fn();
const q = (sel: string) => document.body.querySelector(sel) as HTMLElement | null;
const setValue = (el: HTMLTextAreaElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
const submit = () => Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent === 'chat.report.submitReport') as HTMLButtonElement;

beforeEach(() => {
  vi.clearAllMocks();
  mockPost.mockResolvedValue({ data: { success: true } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('ReportModal — server reports', () => {
  it('titles the dialog for a space and posts { type: server, serverId, reason } with no reportedUserId', async () => {
    await act(async () => { root.render(<ReportModal type="server" serverId="srv-1" onClose={onClose} />); });
    expect(q('[data-testid="report-modal"]')!.textContent).toContain('chat.report.reportSpace');
    await act(async () => { setValue(document.body.querySelector('textarea')!, 'This listing is a scam front.'); });
    await act(async () => { submit().click(); });
    expect(mockPost).toHaveBeenCalledWith('/reports', { type: 'server', serverId: 'srv-1', reason: 'This listing is a scam front.' });
    expect(T.success).toHaveBeenCalledWith('chat.report.submitted');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps reportedUserId for a user report', async () => {
    await act(async () => { root.render(<ReportModal type="user" reportedUserId="u-2" onClose={onClose} />); });
    expect(q('[data-testid="report-modal"]')!.textContent).toContain('chat.report.reportUser');
    await act(async () => { setValue(document.body.querySelector('textarea')!, 'Harassment in the voice lounge.'); });
    await act(async () => { submit().click(); });
    expect(mockPost).toHaveBeenCalledWith('/reports', { type: 'user', reportedUserId: 'u-2', reason: 'Harassment in the voice lounge.' });
  });

  it('a refused report toasts the translated error and stays open', async () => {
    mockPost.mockRejectedValue(new Error('You cannot report your own server'));
    await act(async () => { root.render(<ReportModal type="server" serverId="srv-1" onClose={onClose} />); });
    await act(async () => { setValue(document.body.querySelector('textarea')!, 'Reporting my own space by mistake.'); });
    await act(async () => { submit().click(); });
    expect(T.error).toHaveBeenCalledWith('serverErrors.cannotReportOwnServer');
    expect(onClose).not.toHaveBeenCalled();
  });
});
