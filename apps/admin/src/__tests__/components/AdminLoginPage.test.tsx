import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { SESSION_ENDED_REASON, SIGNED_OUT_ELSEWHERE_REASON } from '@voxium/shared';
import { mount, bodyText, click, getByRole, queryByRole, queryByText, type Mounted } from '../helpers/dom';

const auth = vi.hoisted(() => ({
  state: {
    login: vi.fn(), verifyTOTP: vi.fn(), cancelTOTP: vi.fn(), clearError: vi.fn(), checkAuth: vi.fn(),
    totpRequired: false, isSubmitting: false, error: null as string | null,
    restoreUnavailable: false, isRestoring: false,
  },
}));
vi.mock('../../stores/authStore', () => {
  const useAuthStore = () => auth.state;
  useAuthStore.getState = () => auth.state;
  return { useAuthStore };
});

import { AdminLoginPage } from '../../pages/AdminLoginPage';

let view: Mounted;

async function renderAt(search: string) {
  window.history.replaceState(null, '', `/login${search}`);
  await view.render(<MemoryRouter><AdminLoginPage /></MemoryRouter>);
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.state.restoreUnavailable = false;
  auth.state.isRestoring = false;
  view = mount();
});
afterEach(() => {
  view.unmount();
  window.history.replaceState(null, '', '/');
});

describe('AdminLoginPage sign-out reason', () => {
  it.each([
    [SESSION_ENDED_REASON, 'Your session has ended. Please sign in again.'],
    [SIGNED_OUT_ELSEWHERE_REASON, 'You were signed out from another device. Please sign in again.'],
    ['Your account has been banned', 'Your account has been banned.'],
    ['Your account has been deleted', 'Your account has been deleted.'],
  ])('shows the fixed sentence for %s', async (reason, sentence) => {
    await renderAt(`?reason=${encodeURIComponent(reason)}`);
    expect(view.container.querySelector('[role="status"]')?.textContent).toBe(sentence);
  });

  it('removes the parameter from the address once read', async () => {
    await renderAt(`?reason=${encodeURIComponent(SESSION_ENDED_REASON)}&keep=1`);
    expect(window.location.search).toBe('?keep=1');
    expect(window.location.pathname).toBe('/login');
  });

  it.each([
    ['an unknown reason', '?reason=Something%20else'],
    ['an empty reason', '?reason='],
    ['no reason', ''],
    ['a near-miss (case differs)', '?reason=your%20session%20has%20ended'],
    ['markup', `?reason=${encodeURIComponent('<img src=x onerror=alert(1)><b>Your session has ended</b>')}`],
  ])('shows nothing for %s and renders nothing from the URL text', async (_n, search) => {
    await renderAt(search);
    expect(view.container.querySelector('[role="status"]')).toBeNull();
    expect(view.container.querySelector('img, b')).toBeNull();
    expect(bodyText()).not.toContain('onerror');
    expect(bodyText()).not.toContain('Something else');
    expect(window.location.search).not.toContain('reason');
  });
});

describe('AdminLoginPage after a restore the server did not answer', () => {
  const LINE = 'Your session could not be restored because the server did not answer as expected. It is still kept on this device.';

  it('says so in one line, offers to try again, and keeps the form usable', async () => {
    auth.state.restoreUnavailable = true;
    await renderAt('');
    expect(queryByText(LINE)).not.toBeNull();
    const retry = getByRole('button', 'Try again');
    expect((retry as HTMLButtonElement).disabled).toBe(false);
    expect(getByRole('textbox', 'admin@example.com')).toBeDefined();
    expect((getByRole('button', 'Sign In') as HTMLButtonElement).disabled).toBe(false);
  });

  it('"Try again" runs the restore once, and does not submit the form', async () => {
    auth.state.restoreUnavailable = true;
    await renderAt('');
    await click(getByRole('button', 'Try again'));
    expect(auth.state.checkAuth).toHaveBeenCalledTimes(1);
    expect(auth.state.login).not.toHaveBeenCalled();
  });

  it('the button is disabled while the restore runs', async () => {
    auth.state.restoreUnavailable = true;
    auth.state.isRestoring = true;
    await renderAt('');
    const retry = getByRole('button', 'Trying again...');
    expect((retry as HTMLButtonElement).disabled).toBe(true);
    await click(retry);
    expect(auth.state.checkAuth).not.toHaveBeenCalled();
  });

  it('shows nothing of the kind otherwise', async () => {
    await renderAt('');
    expect(queryByText(LINE)).toBeNull();
    expect(queryByRole('button', 'Try again')).toBeNull();
  });
});
