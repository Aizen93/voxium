import { describe, it, expect, vi, beforeEach } from 'vitest';

const api = vi.hoisted(() => ({ get: vi.fn(), delete: vi.fn() }));
vi.mock('../../services/api', () => ({ api }));

import { listSessions, revokeSession, isSessionListUnavailable } from '../../services/sessions';

const status = (code: number, error?: string) =>
  Object.assign(new Error(`Request failed with status code ${code}`), { isAxiosError: true, response: { status: code, data: { success: false, error } } });

const row = { id: 's-1', clientKind: 'web', clientOs: 'linux', signedInAt: '2026-11-03T00:00:00.000Z', lastActiveAt: '2026-11-20T14:00:00.000Z', current: true };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('services/sessions — the session list and the per-row sign-out', () => {
  it('listSessions answers the rows the server lists', async () => {
    api.get.mockResolvedValueOnce({ data: { success: true, data: { sessions: [row] } } });

    await expect(listSessions()).resolves.toEqual([row]);
    expect(api.get).toHaveBeenCalledWith('/auth/sessions');
  });

  it('a 404 (a server from before sessions) is told apart: null, the screen hides the section', async () => {
    api.get.mockRejectedValueOnce(status(404));

    await expect(listSessions()).resolves.toBeNull();
    expect(isSessionListUnavailable(status(404))).toBe(true);
    expect(isSessionListUnavailable(status(500))).toBe(false);
    expect(isSessionListUnavailable(new Error('x'))).toBe(false);
  });

  it('any other failure throws as itself (a 429, a 401, a 500), and an answer without a list throws', async () => {
    for (const code of [429, 401, 500]) {
      api.get.mockRejectedValueOnce(status(code));
      await expect(listSessions()).rejects.toMatchObject({ response: { status: code } });
    }
    api.get.mockResolvedValueOnce({ data: { success: true, data: {} } });
    await expect(listSessions()).rejects.toThrow('The session list answer carried no list');
  });

  it('revokeSession sends the password in the body (never the URL) and answers the server\'s result', async () => {
    api.delete.mockResolvedValueOnce({ data: { success: true, data: { revoked: 1 } } });

    await expect(revokeSession('s-2', 'pw')).resolves.toEqual({ revoked: 1 });
    expect(api.delete).toHaveBeenCalledWith('/auth/sessions/s-2', { data: { password: 'pw' } });
  });

  it('revokeSession encodes the id and lets the server\'s refusals through (404 Session not found, 400 this session)', async () => {
    api.delete.mockRejectedValueOnce(status(404, 'Session not found'));
    await expect(revokeSession('a/b?c', 'pw')).rejects.toMatchObject({ response: { status: 404 } });
    expect(api.delete).toHaveBeenCalledWith('/auth/sessions/a%2Fb%3Fc', { data: { password: 'pw' } });
  });
});
