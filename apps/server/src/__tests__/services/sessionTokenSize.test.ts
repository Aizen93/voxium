import { describe, it, expect, vi } from 'vitest';
import { LIMITS } from '@voxium/shared';

/**
 * The desktop app keeps the token pair in the OS credential store as ONE
 * JSON entry, `{ accessToken, refreshToken, origin }` (services/
 * tokenStorage.ts), and its shell refuses an entry longer than 1280
 * characters of printable ASCII without spaces (lib.rs,
 * SESSION_SECRET_MAX_CHARS: the Windows blob cap in UTF-16 code units). A
 * write it refuses is only logged, and under rotation the next launch would
 * present a token a renewal already replaced. The largest pair the server
 * can issue, with the longest origin the shell's own test stores, must fit.
 */

const insertSession = vi.hoisted(() => vi.fn());
vi.mock('../../utils/sessionStore', () => ({ insertSession: (...a: unknown[]) => insertSession(...a) }));
vi.mock('../../utils/prisma', () => ({ prisma: {} }));
vi.mock('../../utils/featureFlags', () => ({ isFeatureEnabled: () => false }));
vi.mock('../../utils/sessionRevocation', () => ({ revokeSessionSockets: vi.fn() }));

import { openSession } from '../../services/sessionService';

const SESSION_SECRET_MAX_CHARS = 1280;
const INT_MAX = 2_147_483_647; // the generation and token_version columns are INTEGER

describe('the stored session fits the desktop credential store', () => {
  it('the largest pair, with a long self-hosted origin, stays under 1280 printable characters', async () => {
    insertSession.mockImplementation(async (_db: unknown, row: { id: string }) => ({
      id: row.id,
      generation: INT_MAX,
      rememberMe: false,
      // The largest exp a 365-day session can carry for decades to come
      exp: 9_999_999_999,
    }));
    const { tokens } = await openSession({} as never, {
      userId: 'c'.repeat(30), // a cuid is 25; margin
      username: 'u'.repeat(LIMITS.USERNAME_MAX),
      role: 'superadmin',
      tokenVersion: INT_MAX,
    }, { rememberMe: false, label: { kind: 'desktop', os: 'windows' }, accountGoneMessage: 'x' });

    // As lib.rs's own test stores it: a 240-character host with a port
    const origin = `https://${'h'.repeat(240)}.example.org:8443`;
    const entry = JSON.stringify({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, origin });

    expect(entry.length).toBeLessThanOrEqual(SESSION_SECRET_MAX_CHARS);
    expect([...entry].every((c) => c.charCodeAt(0) >= 0x21 && c.charCodeAt(0) <= 0x7e)).toBe(true);
    // The margin the next claim would have to fit in, said once so it is seen
    expect(SESSION_SECRET_MAX_CHARS - entry.length).toBeGreaterThan(200);
  });
});
