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

describe('AdminAuditLog — rows with no actor', () => {
  const actorCell = (row: HTMLElement) => row.querySelectorAll('td')[1].textContent;
  const detailsCell = (row: HTMLElement) => row.querySelectorAll('td')[3].textContent;
  const SWEEP = { deletedUsers: 4, deletedAvatars: 3, deletedIpRecords: 2, durationMs: 120 };

  async function renderRows(...logs: AuditLogEntry[]) {
    store.auditLogs = logs;
    store.auditLogsTotal = logs.length;
    await act(async () => { root.render(<AdminAuditLog />); });
    return rows();
  }
  const sweep = (id: string, metadata: Record<string, unknown> | null, over: Partial<AuditLogEntry> = {}) =>
    entry({ id, action: 'registration.hygiene_sweep', actorId: null, actorUsername: null, targetType: null, targetId: null, metadata, ...over });

  it('shows "System" for a scheduled hygiene sweep', async () => {
    const [row] = await renderRows(sweep('s', { trigger: 'scheduled', ...SWEEP }));
    expect(actorCell(row)).toBe('System');
  });

  it('shows "Deleted" for a manual hygiene sweep whose admin account is gone', async () => {
    const [row] = await renderRows(sweep('m', { trigger: 'manual', ...SWEEP }));
    expect(actorCell(row)).toBe('Deleted');
  });

  it('shows "System" for an older hygiene row that recorded no trigger', async () => {
    const [noTrigger, noMetadata] = await renderRows(
      sweep('o1', { ...SWEEP }),
      sweep('o2', null),
    );
    expect(actorCell(noTrigger)).toBe('System');
    expect(actorCell(noMetadata)).toBe('System');
  });

  it('shows "Deleted" for any other action without an actor', async () => {
    const [ban, flag] = await renderRows(
      entry({ id: 'b', action: 'user.ban', actorId: null, actorUsername: null, metadata: { reason: 'spam' } }),
      entry({ id: 'f', action: 'feature_flag.update', actorId: null, actorUsername: null, metadata: { enabled: true, trigger: 'scheduled' } }),
    );
    expect(actorCell(ban)).toBe('Deleted');
    // a "scheduled" trigger on an action that is not a scheduled job does not make it the system
    expect(actorCell(flag)).toBe('Deleted');
  });

  it('shows the actor\'s name when there is one, even on a hygiene sweep', async () => {
    const [row] = await renderRows(sweep('n', { trigger: 'manual', ...SWEEP }, { actorId: 'admin-1', actorUsername: 'root' }));
    expect(actorCell(row)).toBe('root');
  });

  it('describes a hygiene sweep by its trigger and what it deleted', async () => {
    const [row] = await renderRows(sweep('d', { trigger: 'scheduled', ...SWEEP }));
    expect(detailsCell(row)).toBe('scheduled: 4 account(s), 3 avatar(s), 2 IP record(s) in 120ms');
  });
});

describe('AdminAuditLog — the report retention job (#48)', () => {
  const actorCell = (row: HTMLElement) => row.querySelectorAll('td')[1].textContent;
  const detailsCell = (row: HTMLElement) => row.querySelectorAll('td')[3].textContent;
  const retention = (id: string, metadata: Record<string, unknown> | null) =>
    entry({ id, action: 'report.retention_sweep', actorId: null, actorUsername: null, targetType: 'report', targetId: null, metadata });

  async function renderRows(...logs: AuditLogEntry[]) {
    store.auditLogs = logs;
    store.auditLogsTotal = logs.length;
    await act(async () => { root.render(<AdminAuditLog />); });
    return rows();
  }

  it('is labelled, run by the system, and described by what it deleted under which period', async () => {
    const [row] = await renderRows(retention('r', { trigger: 'scheduled', deletedReports: 7, retentionMonths: 12 }));

    expect(row.textContent).toContain('Expired Reports Deleted');
    expect(actorCell(row)).toBe('System');
    expect(detailsCell(row)).toBe("7 report(s) kept 12 month(s) after an account's deletion");
  });

  it('says when a batch stopped the run, by the error\'s name', async () => {
    const [row] = await renderRows(retention('f', { trigger: 'scheduled', deletedReports: 1000, retentionMonths: 12, failedBatch: { name: 'PrismaClientKnownRequestError', code: 'P2010' } }));

    expect(detailsCell(row)).toBe("1000 report(s) kept 12 month(s) after an account's deletion | stopped at a failed batch (PrismaClientKnownRequestError)");
  });

  it('is offered in the filter', async () => {
    await act(async () => { root.render(<AdminAuditLog />); });
    const options = Array.from(document.body.querySelectorAll('option')).map((o) => [o.value, o.textContent]);
    expect(options).toEqual(expect.arrayContaining([['report.retention_sweep', 'Expired Reports Deleted']]));
  });
});

describe('AdminAuditLog — a job switched', () => {
  it('is labelled, names the job and shows the old and the new mode', async () => {
    store.auditLogs = [entry({ id: 'j', action: 'job.update', targetType: 'job', targetId: 'session-sweep', metadata: { oldMode: 'on', newMode: 'off' } })];
    store.auditLogsTotal = 1;
    await act(async () => { root.render(<AdminAuditLog />); });
    const [row] = rows();
    expect(row.querySelector('span')!.textContent).toBe('Job Switched');
    expect(row.querySelector('span')!.className).not.toContain('bg-gray-500/20');
    expect(row.textContent).toContain('session-sweep');
    expect(row.querySelectorAll('td')[3].textContent).toBe('on -> off');
  });

  it('is offered in the filter', async () => {
    await act(async () => { root.render(<AdminAuditLog />); });
    const options = Array.from(document.body.querySelectorAll('option')).map((o) => [o.value, o.textContent]);
    expect(options).toEqual(expect.arrayContaining([['job.update', 'Job Switched']]));
  });
});
