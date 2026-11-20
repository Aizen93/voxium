import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Which routes the vault ownership gate stands in front of (App.tsx): only the
// app proper. A signed-in person whose vault another tab owns still reaches
// every public page (verify e-mail, mail block, the legal pages, the invite
// landing), and a signed-out one the sign-in and sign-up pages. THIS test page
// is one tab; the other tab holds the vault's lock in the fake lock manager.

const auth = vi.hoisted(() => ({
  isAuthenticated: true,
  isLoading: false,
  user: { id: 'routes-user', emailVerified: true } as { id: string; emailVerified: boolean } | null,
  checkAuth: vi.fn(),
  logout: vi.fn(),
}));
vi.mock('../../stores/authStore', () => ({ useAuthStore: Object.assign(() => auth, { getState: () => auth }) }));
vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }) };
});
const { page } = vi.hoisted(() => ({ page: (name: string) => () => <main>{name}</main> }));
vi.mock('../../pages/LandingPage', () => ({ LandingPage: page('landing') }));
vi.mock('../../pages/LoginPage', () => ({ LoginPage: page('sign in') }));
vi.mock('../../pages/RegisterPage', () => ({ RegisterPage: page('sign up') }));
vi.mock('../../pages/TermsPage', () => ({ TermsPage: page('terms') }));
vi.mock('../../pages/PrivacyPage', () => ({ PrivacyPage: page('privacy') }));
vi.mock('../../pages/CookiePolicyPage', () => ({ CookiePolicyPage: page('cookies') }));
vi.mock('../../pages/VerifyEmailPage', () => ({ VerifyEmailPage: page('verify e-mail') }));
vi.mock('../../pages/MailBlockPage', () => ({ MailBlockPage: page('mail block') }));
vi.mock('../../pages/InvitePage', () => ({ InvitePage: page('invite') }));
vi.mock('../../components/layout/MainLayout', () => ({ MainLayout: page('app shell') }));
vi.mock('../../components/layout/TitleBar', () => ({ TitleBar: () => null }));
vi.mock('../../components/layout/ToastContainer', () => ({ ToastContainer: () => null }));
vi.mock('../../components/updater/UpdateChecker', () => ({ UpdateChecker: () => null }));
vi.mock('../../services/socket', () => ({ holdSocketConnections: vi.fn(() => () => {}), connectSocket: vi.fn() }));
vi.mock('../../services/tokenStorage', () => ({ getAccessToken: () => 'access-token' }));
vi.mock('../../services/api', () => ({ api: { get: vi.fn() } }));
vi.mock('../../stores/voiceStore', () => ({ useVoiceStore: { getState: () => ({ activeChannelId: null, dmCallConversationId: null }) } }));

import { App } from '../../App';
import { _resetVaultOwnershipGatesForTests } from '../../components/layout/VaultOwnershipGate';
import { VAULT_LOCK_PREFIX, _resetVaultOwnershipForTests, _setVaultOwnershipEnvironmentForTests } from '../../services/e2e/vaultOwnership';
import { vaultDbName } from '../../services/e2e/vault';
import { FakeLocks } from '../helpers/fakeVaultOwnership';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

beforeEach(async () => {
  _resetVaultOwnershipForTests();
  _resetVaultOwnershipGatesForTests();
  const locks = new FakeLocks();
  await locks.otherTab(`${VAULT_LOCK_PREFIX}${vaultDbName('routes-user')}`).granted;
  _setVaultOwnershipEnvironmentForTests({
    locks,
    openChannel: null,
    stamp: async () => 'stamped',
    visibility: () => 'visible',
    watchPageLifecycle: () => {},
    session: () => null,
    local: () => null,
    reload: () => {},
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  _resetVaultOwnershipForTests();
});

async function render(path: string): Promise<string> {
  container = document.createElement('div');
  root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    );
  });
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
  return container.textContent ?? '';
}

describe('routes while another tab owns the vault', () => {
  it.each([
    ['/terms', 'terms'],
    ['/privacy', 'privacy'],
    ['/cookies', 'cookies'],
    ['/verify-email/a-token', 'verify e-mail'],
    ['/mail-block/a-token', 'mail block'],
    ['/invite/a-code', 'invite'],
  ])('%s is never behind the gate', async (path, content) => {
    auth.isAuthenticated = true;
    auth.user = { id: 'routes-user', emailVerified: true };
    expect(await render(path)).toBe(content);
  });

  it.each([
    ['/login', 'sign in'],
    ['/register', 'sign up'],
  ])('%s is never behind it either for a signed-out visitor', async (path, content) => {
    auth.isAuthenticated = false;
    auth.user = null;
    expect(await render(path)).toBe(content);
  });

  it('the app proper is: the screen shows instead', async () => {
    auth.isAuthenticated = true;
    auth.user = { id: 'routes-user', emailVerified: true };
    const shown = await render('/');
    expect(shown).toContain('vaultOwnership.blockedTitle');
    expect(shown).not.toContain('app shell');
  });

  it('another account in this tab is not held back by that tab', async () => {
    auth.isAuthenticated = true;
    auth.user = { id: 'routes-other-user', emailVerified: true };
    expect(await render('/')).toBe('app shell');
  });
});
