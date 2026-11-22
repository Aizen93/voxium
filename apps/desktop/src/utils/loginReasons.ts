import { SESSION_ENDED_REASON, SIGNED_OUT_ELSEWHERE_REASON } from '@voxium/shared';

/**
 * Why a session ended, as the sign-in page says it.
 *
 * The server tells a socket why it signs it out (`force:logout { reason }`);
 * the client then signs out locally and opens `/login?reason=<code>`, where
 * the code comes from this CLOSED list, and the sign-in page shows the
 * mapped sentence in the reader's language. Anyone can craft a link to the
 * sign-in page: a value outside the list shows nothing, and the raw value is
 * never rendered. A reason the list does not know opens `/login` alone.
 */
export const LOGIN_REASON_KEYS = {
  /** Signed out from another of the account's sessions (one session, or all the others). */
  'signed-out-elsewhere': 'auth.login.reason.signedOutElsewhere',
  /** The server ended this session: a sign-out sent with its refresh token, a reused one, too many sessions. */
  'session-ended': 'auth.login.reason.sessionEnded',
  'banned': 'auth.login.reason.accountBanned',
  'deleted': 'auth.login.reason.accountDeleted',
} as const;

export type LoginReason = keyof typeof LOGIN_REASON_KEYS;

/** The `force:logout` reasons the server sends, by their code. */
const BY_SERVER_REASON: Readonly<Record<string, LoginReason>> = {
  [SIGNED_OUT_ELSEWHERE_REASON]: 'signed-out-elsewhere',
  [SESSION_ENDED_REASON]: 'session-ended',
  'Your account has been banned': 'banned',
  'Your account has been deleted': 'deleted',
};

/** The code of a `force:logout` reason, or null for one the list does not know. */
export function loginReasonOf(serverReason: unknown): LoginReason | null {
  return typeof serverReason === 'string' && Object.hasOwn(BY_SERVER_REASON, serverReason) ? BY_SERVER_REASON[serverReason] : null;
}

/** Where a signed-out page goes: the sign-in page, with the reason's code when there is one. */
export function loginPathFor(reason: LoginReason | null): string {
  return reason ? `/login?reason=${reason}` : '/login';
}

/** The translation key of the sign-in page's `?reason=` value, or null for anything not in the list. */
export function loginReasonKey(param: string | null): string | null {
  return param !== null && Object.hasOwn(LOGIN_REASON_KEYS, param) ? LOGIN_REASON_KEYS[param as LoginReason] : null;
}
