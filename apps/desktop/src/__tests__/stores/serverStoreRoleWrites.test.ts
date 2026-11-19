import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';

/**
 * The wire of the three permission writes (#75): every permission value a
 * role or override write sends goes with `knownPermissions`, the bits this
 * build knows, so the server takes those bits from the request and keeps
 * every other bit as stored. A write that sends no permission value names no
 * mask (a rename stays a rename on every server).
 */

vi.mock('../../services/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

import { useServerStore } from '../../stores/serverStore';
import { api } from '../../services/api';
import { ALL_PERMISSIONS, Permissions } from '@voxium/shared';

const post = api.post as unknown as Mock;
const patch = api.patch as unknown as Mock;
const put = api.put as unknown as Mock;
const KNOWN = ALL_PERMISSIONS.toString();

beforeEach(() => {
  vi.clearAllMocks();
  post.mockResolvedValue({ data: { data: { id: 'r-new' } } });
  patch.mockResolvedValue({ data: { success: true } });
  put.mockResolvedValue({ data: { success: true } });
});

describe('updateRole', () => {
  it('a rename sends the name alone: no permissions, no mask', async () => {
    await useServerStore.getState().updateRole('s1', 'r1', { name: 'Helpers' });
    expect(patch).toHaveBeenCalledWith('/servers/s1/roles/r1', { name: 'Helpers' });
  });

  it('a colour change sends the colour alone', async () => {
    await useServerStore.getState().updateRole('s1', 'r1', { color: null });
    expect(patch).toHaveBeenCalledWith('/servers/s1/roles/r1', { color: null });
  });

  it('a permission value goes with every bit this build knows', async () => {
    const permissions = String(Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES);
    await useServerStore.getState().updateRole('s1', 'r1', { name: 'Helpers', permissions });
    expect(patch).toHaveBeenCalledWith('/servers/s1/roles/r1', { name: 'Helpers', permissions, knownPermissions: KNOWN });
  });
});

describe('createRole', () => {
  it('without permissions, no mask', async () => {
    await useServerStore.getState().createRole('s1', 'New role');
    expect(post).toHaveBeenCalledWith('/servers/s1/roles', { name: 'New role', color: undefined, permissions: undefined });
    expect(post.mock.calls[0][1]).not.toHaveProperty('knownPermissions');
  });

  it('with permissions, the mask goes with them', async () => {
    await useServerStore.getState().createRole('s1', 'New role', '#ff0000', '1');
    expect(post).toHaveBeenCalledWith('/servers/s1/roles', { name: 'New role', color: '#ff0000', permissions: '1', knownPermissions: KNOWN });
  });
});

describe('setChannelPermissionOverride', () => {
  it('allow and deny go with the mask, 0/0 included (the server removes an override left empty)', async () => {
    await useServerStore.getState().setChannelPermissionOverride('s1', 'ch1', 'r1', '0', '0');
    expect(put).toHaveBeenCalledWith('/servers/s1/roles/channels/ch1/permissions/r1', { allow: '0', deny: '0', knownPermissions: KNOWN });
  });
});
