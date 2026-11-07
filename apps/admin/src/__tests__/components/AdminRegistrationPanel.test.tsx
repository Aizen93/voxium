import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * The registration-abuse panel's wording against what the server computes:
 * - the IP list groups `register` IP records by the account's creation date,
 *   so it is the addresses that registered accounts this week;
 * - the sweep the "Run now" confirmation describes also deletes IP records
 *   not seen for IP_RECORD_RETENTION_DAYS (@voxium/shared, used by utils/registrationHygiene.ts).
 */

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../../services/api', () => ({ api }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('../../stores/toastStore', () => ({ toast }));

import { IP_RECORD_RETENTION_DAYS } from '@voxium/shared';
import { AdminRegistrationPanel } from '../../components/AdminRegistrationPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const STATS = {
  lastHour: 1, last24h: 4, unverifiedTotal: 3,
  topRegisterIps: [{ ip: '203.0.113.7', registrations: 5 }],
  topDomains: [{ domain: 'example.com', registrations: 4 }],
};
const HYGIENE = { lastRun: null, history: [], pendingDeletions: 2, ttlDays: 7 };

let container: HTMLDivElement;
let root: Root;
const buttons = () => Array.from(document.body.querySelectorAll('button')) as HTMLButtonElement[];

async function render() {
  await act(async () => { root.render(<AdminRegistrationPanel />); });
}

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockImplementation(async (url: string) => ({
    data: { data: url === '/admin/registration-stats' ? STATS : HYGIENE },
  }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('AdminRegistrationPanel — wording', () => {
  it('labels the IP list as accounts created this week', async () => {
    await render();
    const text = document.body.textContent ?? '';
    expect(text).toContain('Top registration IPs (accounts created in the last 7 days)');
    expect(text).not.toContain('Top registering IPs (7 days)');
    expect(text).toContain('203.0.113.7');
  });

  it('the run-now confirmation says the sweep also deletes IP records unseen for 180 days', async () => {
    await render();
    const runNow = buttons().find((b) => b.textContent?.includes('Run now'));
    expect(runNow, 'Run now is offered while accounts are queued').toBeDefined();
    await act(async () => { runNow!.click(); });
    const text = document.body.textContent ?? '';
    expect(text).toContain('This permanently deletes 2 accounts that never verified their email address and are older than 7 days');
    expect(text).toContain(`It also deletes IP records not seen for ${IP_RECORD_RETENTION_DAYS} days.`);
  });
});
