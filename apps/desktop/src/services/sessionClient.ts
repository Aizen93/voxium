import type { SessionClientHint } from '@voxium/shared';

/**
 * The kind of app this client is, as the sign-in, two-factor, registration,
 * refresh, password-change and "sign out of all other sessions" bodies carry
 * it (`client`, shared `SessionClientField`): the server labels the session a
 * sign-in opens with it, and on a refresh only notes that the field was
 * present. 'desktop' in the Tauri app, 'web' in the browser build. Read at
 * each call: the answer depends on the page, never on a stored value.
 */
export function sessionClientHint(): SessionClientHint {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window ? 'desktop' : 'web';
}
