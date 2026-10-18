import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AuditLogEntry } from '@voxium/shared';

/**
 * The audit log renders the webhook moderation actions (labels, filter
 * options, details). Every AuditAction having a label is pinned at compile
 * time by the exhaustive `ACTION_LABELS: Record<AuditAction, string>`.
 */

const store = vi.hoisted(() => ({
  auditLogs: [] as AuditLogEntry[],
  auditLogsTotal: 0,
  auditLogsPage: 1,
  auditLogsFilter: '',
  auditLogsSearch: '',
  fetchAuditLogs: vi.fn(),
  setAuditLogsFilter: vi.fn(),
  setAuditLogsSearch: vi.fn(),
}));
vi.mock('../../stores/adminStore', () => ({ useAdminStore: Object.assign(() => store, { getState: () => store }) }));

import { AdminAuditLog } from '../../components/AdminAuditLog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function entry(over: Partial<AuditLogEntry>): AuditLogEntry {
  return {
    id: 'log', actorId: 'admin-1', actorUsername: 'root', action: 'webhook.disable', targetType: 'webhook', targetId: 'wh-1',
    metadata: { serverId: 'srv-1', channelId: 'ch-1', name: 'CI' }, createdAt: '2026-10-18T12:00:00.000Z', ...over,
  };
}

let container: HTMLDivElement;
let root: Root;
const rows = () => Array.from(document.body.querySelectorAll('tbody tr')) as HTMLElement[];

beforeEach(() => {
  vi.clearAllMocks();
  store.auditLogs = [
    entry({ id: 'a', action: 'webhook.disable' }),
    entry({ id: 'b', action: 'webhook.enable' }),
    entry({ id: 'c', action: 'webhook.delete', metadata: { serverId: 'srv-1', channelId: 'ch-1', name: 'CI', purge: true, deletedMessages: 13 } }),
    entry({ id: 'd', action: 'webhook.delete', metadata: { serverId: 'srv-1', channelId: 'ch-1', name: 'Old', purge: false, deletedMessages: 0 } }),
  ];
  store.auditLogsTotal = 4;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('AdminAuditLog — webhook moderation rows', () => {
  it('labels the three webhook actions and shows what was touched', async () => {
    await act(async () => { root.render(<AdminAuditLog />); });
    const [disable, enable, purged, kept] = rows();
    expect(disable.textContent).toContain('Webhook Disabled');
    expect(disable.textContent).toContain('"CI" (server srv-1)');
    expect(disable.textContent).toContain('webhook:');
    expect(enable.textContent).toContain('Webhook Enabled');
    expect(purged.textContent).toContain('Webhook Deleted');
    expect(purged.textContent).toContain('13 message(s) deleted');
    expect(kept.textContent).toContain('"Old" (server srv-1)');
    expect(kept.textContent).toContain('messages kept');
  });

  it('offers the three actions in the filter', async () => {
    await act(async () => { root.render(<AdminAuditLog />); });
    const options = Array.from(document.body.querySelectorAll('option')).map((o) => [o.value, o.textContent]);
    expect(options).toEqual(expect.arrayContaining([
      ['webhook.disable', 'Webhook Disabled'],
      ['webhook.enable', 'Webhook Enabled'],
      ['webhook.delete', 'Webhook Deleted'],
    ]));
  });
});
