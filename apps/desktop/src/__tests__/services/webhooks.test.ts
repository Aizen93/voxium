import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import { AxiosError, type AxiosResponse } from 'axios';

/**
 * services/webhooks.ts: the management calls hit the right routes, the
 * public URL is composed on the CLIENT's API base (the server never builds
 * it), and the flag-off 403 is told apart from every other refusal.
 */

const { base } = vi.hoisted(() => ({ base: { value: 'https://voxium.test/api/v1' } }));
vi.mock('../../services/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  get API_BASE() { return base.value; },
}));

import { api } from '../../services/api';
import {
  createWebhook,
  deleteWebhook,
  isWebhooksOff,
  listWebhooks,
  rotateWebhook,
  updateWebhook,
  webhookCurlCommand,
  webhookUrl,
  WEBHOOKS_DISABLED_MESSAGE,
} from '../../services/webhooks';

const mock = (fn: unknown) => fn as Mock;

function axiosError(status: number, error?: string): AxiosError {
  return new AxiosError('Request failed', String(status), undefined, undefined, {
    status, statusText: '', headers: {}, config: {} as never, data: error === undefined ? {} : { success: false, error },
  } as AxiosResponse);
}

beforeEach(() => {
  vi.clearAllMocks();
  base.value = 'https://voxium.test/api/v1';
});

describe('webhookUrl', () => {
  it('composes ${API_BASE}/webhooks/${id}/${token}', () => {
    expect(webhookUrl('wh-1', 'tok_ABC-123')).toBe('https://voxium.test/api/v1/webhooks/wh-1/tok_ABC-123');
  });

  it('tolerates a trailing slash on the configured base (no double slash in the URL)', () => {
    base.value = 'https://voxium.test/api/v1/';
    expect(webhookUrl('wh-1', 'tok')).toBe('https://voxium.test/api/v1/webhooks/wh-1/tok');
  });

  it('the curl line posts a JSON content payload to exactly that URL', () => {
    const url = webhookUrl('wh-1', 'tok');
    expect(webhookCurlCommand(url)).toBe(`curl -H 'content-type: application/json' -d '{"content":"hello from cron"}' ${url}`);
  });
});

describe('isWebhooksOff', () => {
  it('is true for the flag-off 403 and its exact message only', () => {
    expect(WEBHOOKS_DISABLED_MESSAGE).toBe('Webhooks are currently disabled');
    expect(isWebhooksOff(axiosError(403, 'Webhooks are currently disabled'))).toBe(true);
  });

  it('is false for every other refusal', () => {
    expect(isWebhooksOff(axiosError(403, 'You do not have permission to manage webhooks'))).toBe(false);
    expect(isWebhooksOff(axiosError(403))).toBe(false);
    expect(isWebhooksOff(axiosError(500, 'Webhooks are currently disabled'))).toBe(false);
    expect(isWebhooksOff(new Error('Webhooks are currently disabled'))).toBe(false);
    expect(isWebhooksOff({ response: { status: 403, data: { error: 'Webhooks are currently disabled' } } })).toBe(false);
    expect(isWebhooksOff(undefined)).toBe(false);
  });
});

describe('management calls', () => {
  const webhook = {
    id: 'wh-1', serverId: 'srv-1', channelId: 'ch-1', name: 'CI', type: 'generic', enabled: true,
    createdBy: null, createdAt: '2026-10-18T00:00:00.000Z', lastUsedAt: null,
  };

  it('lists GET /servers/:id/webhooks and unwraps the visible rows with the server-wide total', async () => {
    mock(api.get).mockResolvedValue({ data: { success: true, data: [webhook], total: 3 } });
    await expect(listWebhooks('srv-1')).resolves.toEqual({ webhooks: [webhook], total: 3 });
    expect(api.get).toHaveBeenCalledWith('/servers/srv-1/webhooks');
  });

  it('an older server without `total`: the visible rows are the count', async () => {
    mock(api.get).mockResolvedValue({ data: { success: true, data: [webhook, { ...webhook, id: 'wh-2' }] } });
    await expect(listWebhooks('srv-1')).resolves.toMatchObject({ total: 2 });
    mock(api.get).mockResolvedValue({ data: { success: true, data: [] } });
    await expect(listWebhooks('srv-1')).resolves.toEqual({ webhooks: [], total: 0 });
  });

  it('a malformed `total` falls back to the visible rows, and is never below them', async () => {
    for (const total of ['3', -1, 1.5, Number.NaN, null]) {
      mock(api.get).mockResolvedValue({ data: { success: true, data: [webhook, { ...webhook, id: 'wh-2' }], total } });
      await expect(listWebhooks('srv-1'), `total ${String(total)}`).resolves.toMatchObject({ total: 2 });
    }
    mock(api.get).mockResolvedValue({ data: { success: true, data: [webhook, { ...webhook, id: 'wh-2' }], total: 1 } });
    await expect(listWebhooks('srv-1')).resolves.toMatchObject({ total: 2 });
  });

  it('creates with the exact body and returns the one-time token', async () => {
    mock(api.post).mockResolvedValue({ data: { success: true, data: { ...webhook, token: 'tok' } } });
    const created = await createWebhook('srv-1', { channelId: 'ch-1', name: 'CI', type: 'generic' });
    expect(created.token).toBe('tok');
    expect(api.post).toHaveBeenCalledWith('/servers/srv-1/webhooks', { channelId: 'ch-1', name: 'CI', type: 'generic' });
  });

  it('patches /:webhookId with the patch as given', async () => {
    mock(api.patch).mockResolvedValue({ data: { success: true, data: { ...webhook, enabled: false } } });
    await updateWebhook('srv-1', 'wh-1', { enabled: false });
    expect(api.patch).toHaveBeenCalledWith('/servers/srv-1/webhooks/wh-1', { enabled: false });
  });

  it('rotates with POST /:webhookId/rotate', async () => {
    mock(api.post).mockResolvedValue({ data: { success: true, data: { ...webhook, token: 'new' } } });
    await expect(rotateWebhook('srv-1', 'wh-1')).resolves.toMatchObject({ token: 'new' });
    expect(api.post).toHaveBeenCalledWith('/servers/srv-1/webhooks/wh-1/rotate');
  });

  it('deletes without purge by default, with ?purge=1 when asked', async () => {
    mock(api.delete).mockResolvedValue({ data: { success: true, data: { deletedMessages: 0 } } });
    await deleteWebhook('srv-1', 'wh-1', false);
    expect(api.delete).toHaveBeenLastCalledWith('/servers/srv-1/webhooks/wh-1', undefined);

    mock(api.delete).mockResolvedValue({ data: { success: true, data: { deletedMessages: 7 } } });
    await expect(deleteWebhook('srv-1', 'wh-1', true)).resolves.toEqual({ deletedMessages: 7 });
    expect(api.delete).toHaveBeenLastCalledWith('/servers/srv-1/webhooks/wh-1', { params: { purge: '1' } });
  });

  it('lets a refusal through untouched (the caller decides between OFF state and toast)', async () => {
    const off = axiosError(403, 'Webhooks are currently disabled');
    mock(api.get).mockRejectedValue(off);
    await expect(listWebhooks('srv-1')).rejects.toBe(off);
  });
});
