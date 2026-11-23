// @vitest-environment node
// A source scan, like mainLayoutKickToast.test.ts: MainLayout's socket
// handlers are mounted by no component test.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

describe('the wiring', () => {
  const layout = readFileSync(fileURLToPath(new URL('../../components/layout/MainLayout.tsx', import.meta.url)), 'utf8');
  const reset = readFileSync(fileURLToPath(new URL('../../stores/resetStores.ts', import.meta.url)), 'utf8');

  it('channel:permissions_updated invalidates the space\'s answers before it reloads the space', () => {
    const start = layout.indexOf('channelPermissionsUpdated: (');
    const end = layout.indexOf('memberKicked:', start);
    expect(start).toBeGreaterThan(-1);
    const handler = layout.slice(start, end);
    expect(handler).toContain('invalidateChannelPermissions(serverId)');
    expect(handler.indexOf('invalidateChannelPermissions')).toBeLessThan(handler.indexOf('setActiveServer'));
  });

  it('the logout reset empties the cache', () => {
    expect(reset).toContain('resetChannelPermissionsCache()');
  });
});
