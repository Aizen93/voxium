import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AuditLogEntry } from '@voxium/shared';

/**
 * The audit log renders the webhook moderation and resource-limit actions
 * (labels, filter options, details). Every AuditAction having a label is
 * pinned at compile time by the exhaustive `ACTION_LABELS: Record<AuditAction, string>`.
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

describe('AdminAuditLog — resource limit rows', () => {
  const GLOBAL_BEFORE = { maxChannelsPerServer: 20, maxVoiceUsersPerChannel: 12, maxCategoriesPerServer: 12, maxMembersPerServer: 0, maxWebhooksPerServer: 10, maxSecureChannelsPerServer: 5 };
  const NO_OVERRIDES = { maxChannelsPerServer: null, maxVoiceUsersPerChannel: null, maxCategoriesPerServer: null, maxMembersPerServer: null, maxWebhooksPerServer: null, maxSecureChannelsPerServer: null };
  const details = (row: HTMLElement) => row.querySelectorAll('td')[3].textContent;

  async function renderRows(...logs: AuditLogEntry[]) {
    store.auditLogs = logs;
    store.auditLogsTotal = logs.length;
    await act(async () => { root.render(<AdminAuditLog />); });
    return rows();
  }

  it('labels the three limit actions, each with its own colour', async () => {
    const [global, server, reset] = await renderRows(
      entry({ id: 'g', action: 'limits.update_global', targetType: 'global_config', targetId: 'global', metadata: null }),
      entry({ id: 's', action: 'limits.update_server', targetType: 'server', targetId: 'srv-1', metadata: null }),
      entry({ id: 'r', action: 'limits.reset_server', targetType: 'server', targetId: 'srv-1', metadata: null }),
    );
    const chip = (row: HTMLElement) => row.querySelector('span')!;
    expect(chip(global).textContent).toBe('Global Limits Updated');
    expect(chip(server).textContent).toBe('Server Limits Updated');
    expect(chip(reset).textContent).toBe('Server Limits Reset');
    // a known action never falls back to the grey "unknown" chip
    for (const row of [global, server, reset]) expect(chip(row).className).not.toContain('bg-gray-500/20');
    expect(new Set([global, server, reset].map((row) => chip(row).className)).size).toBe(3);
    expect(global.textContent).toContain('global_config:');
    expect(server.textContent).toContain('server:');
  });

  it('a global update lists the changed fields only, as before → after', async () => {
    const [row] = await renderRows(entry({
      action: 'limits.update_global', targetType: 'global_config', targetId: 'global',
      metadata: { before: GLOBAL_BEFORE, after: { ...GLOBAL_BEFORE, maxWebhooksPerServer: 0, maxMembersPerServer: 500 } },
    }));
    expect(details(row)).toBe('Members / server: 0 → 500, Webhooks / server: 10 → 0');
  });

  it('names the secure-channel limit in a global update', async () => {
    const [row] = await renderRows(entry({
      action: 'limits.update_global', targetType: 'global_config', targetId: 'global',
      metadata: { before: GLOBAL_BEFORE, after: { ...GLOBAL_BEFORE, maxSecureChannelsPerServer: 3 } },
    }));
    expect(details(row)).toBe('Secure channels / server: 5 → 3');
  });

  it('a server update says "global" for a field that uses the global default', async () => {
    const [row] = await renderRows(entry({
      action: 'limits.update_server', targetType: 'server', targetId: 'srv-1',
      metadata: {
        before: { ...NO_OVERRIDES, maxChannelsPerServer: 40 },
        after: { ...NO_OVERRIDES, maxWebhooksPerServer: 3 },
      },
    }));
    expect(details(row)).toBe('Channels / server: 40 → global, Webhooks / server: global → 3');
  });

  it('a server update from no override row at all (before: null) reads every old value as global', async () => {
    const [row] = await renderRows(entry({
      action: 'limits.update_server', targetType: 'server', targetId: 'srv-1',
      metadata: { before: null, after: { ...NO_OVERRIDES, maxVoiceUsersPerChannel: 25 } },
    }));
    expect(details(row)).toBe('Voice users / channel: global → 25');
  });

  it('a reset lists every override it removed, back to global', async () => {
    const [row, empty] = await renderRows(
      entry({
        id: 'r1', action: 'limits.reset_server', targetType: 'server', targetId: 'srv-1',
        metadata: { before: { ...NO_OVERRIDES, maxCategoriesPerServer: 30, maxWebhooksPerServer: 0 } },
      }),
      entry({ id: 'r2', action: 'limits.reset_server', targetType: 'server', targetId: 'srv-2', metadata: { before: null } }),
    );
    expect(details(row)).toBe('Categories / server: 30 → global, Webhooks / server: 0 → global');
    expect(details(empty)).toBe('No overrides were set');
  });

  it('an update that changed nothing says so; a numeric field the client does not know keeps its raw name; non-limits are left out', async () => {
    const [same, unknown] = await renderRows(
      entry({ id: 'n', action: 'limits.update_global', targetType: 'global_config', targetId: 'global', metadata: { before: GLOBAL_BEFORE, after: GLOBAL_BEFORE } }),
      entry({
        id: 'u', action: 'limits.update_global', targetType: 'global_config', targetId: 'global',
        metadata: {
          before: { ...GLOBAL_BEFORE, maxThreadsPerChannel: 5, updatedAt: '2026-10-18T00:00:00.000Z' },
          after: { ...GLOBAL_BEFORE, maxThreadsPerChannel: 8, updatedAt: '2026-10-19T00:00:00.000Z' },
        },
      }),
    );
    expect(details(same)).toBe('No change');
    expect(details(unknown)).toBe('maxThreadsPerChannel: 5 → 8');
  });

  it('a row without readable snapshots shows a dash, not a guess', async () => {
    const [row] = await renderRows(entry({ action: 'limits.update_server', targetType: 'server', targetId: 'srv-1', metadata: null }));
    expect(details(row)).toBe('-');
  });

  it('offers the three limit actions in the filter', async () => {
    await act(async () => { root.render(<AdminAuditLog />); });
    const options = Array.from(document.body.querySelectorAll('option')).map((o) => [o.value, o.textContent]);
    expect(options).toEqual(expect.arrayContaining([
      ['limits.update_global', 'Global Limits Updated'],
      ['limits.update_server', 'Server Limits Updated'],
      ['limits.reset_server', 'Server Limits Reset'],
    ]));
  });
});
