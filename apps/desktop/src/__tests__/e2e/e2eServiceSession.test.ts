import 'fake-indexeddb/auto';
import { describe, it, expect, vi, afterEach } from 'vitest';

// The service takes an injected client; the real one drags in axios/socket.io
vi.mock('../../services/api', () => ({ api: {} }));

import { getE2EService, disposeE2EService, E2EService, E2EServiceDisposedError } from '../../services/e2e/e2eService';
import { registerE2ESessionUser, currentE2ESessionUser } from '../../services/e2e/session';

/**
 * A caller that read the user id before an await (a reply quote resolved after
 * a decrypt, a voice key step) can come back after that user signed out. A
 * service created for it would open, and after an account deletion recreate,
 * the vault of an account nobody is signed in to.
 */
describe('getE2EService and the signed-in session', () => {
  afterEach(() => {
    disposeE2EService();
    registerE2ESessionUser(null);
  });

  it('refuses a service for a user who is not the one signed in', () => {
    let signedIn: string | null = 'alice';
    registerE2ESessionUser(() => signedIn);

    const alices = getE2EService('alice');
    expect(alices).toBeInstanceOf(E2EService);
    expect(getE2EService('alice')).toBe(alices);

    // logout
    disposeE2EService();
    signedIn = null;
    expect(() => getE2EService('alice')).toThrow(E2EServiceDisposedError);

    // and while another account is signed in
    signedIn = 'bob';
    expect(() => getE2EService('alice')).toThrow(E2EServiceDisposedError);
    expect(getE2EService('bob')).toBeInstanceOf(E2EService);
  });

  it('does not stand in the way when nothing reports a session (unit tests of the service itself)', () => {
    expect(currentE2ESessionUser()).toBeUndefined();
    expect(getE2EService('anyone')).toBeInstanceOf(E2EService);
  });
});
