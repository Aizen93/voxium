import 'fake-indexeddb/auto';
import { describe, it, expect, vi, afterEach } from 'vitest';

// The service takes an injected client; the real one drags in axios/socket.io
vi.mock('../../services/api', () => ({ api: {} }));

import { getE2EService, scopeMarkedPurged, disposeE2EService } from '../../services/e2e/e2eService';
import { registerE2ESessionUser } from '../../services/e2e/session';

/**
 * scopeMarkedPurged, the display gate's question about an earlier session's
 * purge mark (`ptpurge:read-only:{conversationId}`): asked of the signed-in
 * account's own service (getE2EService, with its default vault and pickle-key
 * provider, which this jsdom suite can run), never of anyone else's.
 */

let n = 0;

afterEach(() => {
  disposeE2EService();
  registerE2ESessionUser(null);
});

describe('scopeMarkedPurged', () => {
  it('answers from the signed-in account\'s service, false before that service exists and for anyone else', async () => {
    const account = `marks-${++n}`;
    registerE2ESessionUser(() => account);
    expect(scopeMarkedPurged(account, 'conv-a')).toBe(false); // no service yet

    const service = getE2EService(account);
    await service.purgeCachedPlaintexts(['conv-a'], () => false, { mark: 'read-only' });
    expect(await scopeMarkedPurged(account, 'conv-a')).toBe(true);
    expect(await scopeMarkedPurged(account, 'conv-b')).toBe(false);
    // loaded: a boolean, no await
    expect(scopeMarkedPurged(account, 'conv-a')).toBe(true);
    expect(scopeMarkedPurged('someone-else', 'conv-a')).toBe(false);
    expect(scopeMarkedPurged(null, 'conv-a')).toBe(false);
    expect(scopeMarkedPurged(undefined, 'conv-a')).toBe(false);
  });

  it('a mark of another purge name does not count', async () => {
    const account = `marks-${++n}`;
    registerE2ESessionUser(() => account);
    await getE2EService(account).purgeCachedPlaintexts(['conv-a'], () => false, { mark: 'floor' });
    expect(await scopeMarkedPurged(account, 'conv-a')).toBe(false);
  });
});
