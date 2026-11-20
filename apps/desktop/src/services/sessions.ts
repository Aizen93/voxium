import axios from 'axios';
import type { RevokeSessionRequest, RevokeSessionResponse, SessionListResponse, SessionSummary } from '@voxium/shared';
import { api } from './api';

/**
 * The account's sign-in sessions (Settings → Security): thin typed calls
 * over the authenticated API. Signing out of ALL the other sessions moves
 * the account to a new token version and is a credential change of this
 * client: it is `useAuthStore().revokeOtherSessions(password)`, which keeps
 * the rules around it (renewals held, the new pair stored, the socket
 * reopened).
 *
 * Errors are the server's: mapped for display through utils/serverErrors.ts
 * (`getTranslatedError`). Nothing here stores or logs anything.
 */

/**
 * The account's live sessions, the caller's own first (`current`), then the
 * most recently renewed. `null` when the server has no such list (a 404:
 * a server from before sessions): the screen hides the section. Every other
 * failure throws, an answer without a list included.
 */
export async function listSessions(): Promise<SessionSummary[] | null> {
  try {
    const { data } = await api.get<{ success: boolean; data: SessionListResponse }>('/auth/sessions');
    const sessions = data?.data?.sessions;
    if (!Array.isArray(sessions)) throw new Error('The session list answer carried no list');
    return sessions;
  } catch (err) {
    if (isSessionListUnavailable(err)) return null;
    throw err;
  }
}

/** Whether `err` says the server has no session list (the route answered 404). */
export function isSessionListUnavailable(err: unknown): boolean {
  return axios.isAxiosError(err) && err.response?.status === 404;
}

/**
 * Sign out of one OTHER session, behind the account password. Its sockets
 * are told and closed by the server; no token version moves, so this device
 * keeps its pair, and the device signed out keeps its trusted-device token.
 * The server answers 404 `Session not found` for an unknown id and for
 * another account's alike, and 400 for this device's own session.
 */
export async function revokeSession(sessionId: string, password: string): Promise<RevokeSessionResponse> {
  const body: RevokeSessionRequest = { password };
  const { data } = await api.delete<{ success: boolean; data: RevokeSessionResponse }>(
    `/auth/sessions/${encodeURIComponent(sessionId)}`,
    { data: body },
  );
  return data.data;
}
