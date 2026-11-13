import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../App';

const auth = vi.hoisted(() => ({
  isAuthenticated: false,
  isLoading: false,
  user: { emailVerified: true },
  checkAuth: vi.fn(),
}));

vi.mock('../../stores/authStore', () => ({ useAuthStore: () => auth }));
vi.mock('../../pages/LandingPage', () => ({
  LandingPage: ({ page }: { page: string }) => <main>{page}</main>,
}));
vi.mock('../../pages/LoginPage', () => ({ LoginPage: () => <main>Sign in</main> }));
vi.mock('../../components/layout/MainLayout', () => ({ MainLayout: () => <main>App shell</main> }));
vi.mock('../../components/layout/TitleBar', () => ({ TitleBar: () => null }));
vi.mock('../../components/layout/ToastContainer', () => ({ ToastContainer: () => null }));
vi.mock('../../components/updater/UpdateChecker', () => ({ UpdateChecker: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function CurrentPath() {
  return <output>{useLocation().pathname}</output>;
}

afterEach(() => vi.unstubAllGlobals());

describe.each(['architecture', 'contributors'])('public route /%s', (page) => {
  it.each([
    { visitor: 'signed-out web', signedIn: false, tauri: false, path: `/${page}`, content: page },
    { visitor: 'signed-in web', signedIn: true, tauri: false, path: '/', content: 'App shell' },
    { visitor: 'signed-out Tauri', signedIn: false, tauri: true, path: '/login', content: 'Sign in' },
  ])('handles $visitor visitors', ({ signedIn, tauri, path, content }) => {
    auth.isAuthenticated = signedIn;
    if (tauri) vi.stubGlobal('__TAURI_INTERNALS__', {});
    const container = document.createElement('div');
    const root = createRoot(container);

    try {
      act(() => root.render(
        <MemoryRouter initialEntries={[`/${page}`]}>
          <App />
          <CurrentPath />
        </MemoryRouter>,
      ));
      expect(container.querySelector('output')?.textContent).toBe(path);
      expect(container.querySelector('main')?.textContent).toBe(content);
    } finally {
      act(() => root.unmount());
    }
  });
});
