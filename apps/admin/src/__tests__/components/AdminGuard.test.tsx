import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { mount, bodyText, type Mounted } from '../helpers/dom';

/**
 * The guard in front of the admin layout: only an admin or a superadmin gets
 * the children; everyone else is sent to the login page.
 */

const auth = vi.hoisted(() => ({
  state: { user: null as { role: string } | null, isLoading: false },
}));
vi.mock('../../stores/authStore', () => ({
  useAuthStore: (selector: (s: typeof auth.state) => unknown) => selector(auth.state),
}));

import { AdminGuard } from '../../components/AdminGuard';

let view: Mounted;

async function renderGuard() {
  await view.render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/login" element={<p>Login page</p>} />
        <Route path="/" element={<AdminGuard><p>Admin panel</p></AdminGuard>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  auth.state = { user: null, isLoading: false };
  view = mount();
});
afterEach(() => view.unmount());

describe('AdminGuard', () => {
  it('sends a signed-out visitor to the login page and shows no children', async () => {
    await renderGuard();
    expect(bodyText()).toContain('Login page');
    expect(bodyText()).not.toContain('Admin panel');
  });

  it('sends a signed-in ordinary user to the login page and shows no children', async () => {
    auth.state = { user: { role: 'user' }, isLoading: false };
    await renderGuard();
    expect(bodyText()).toContain('Login page');
    expect(bodyText()).not.toContain('Admin panel');
  });

  it('shows the children to an admin', async () => {
    auth.state = { user: { role: 'admin' }, isLoading: false };
    await renderGuard();
    expect(bodyText()).toContain('Admin panel');
    expect(bodyText()).not.toContain('Login page');
  });

  it('shows the children to a superadmin', async () => {
    auth.state = { user: { role: 'superadmin' }, isLoading: false };
    await renderGuard();
    expect(bodyText()).toContain('Admin panel');
    expect(bodyText()).not.toContain('Login page');
  });

  it('does not treat an unknown role as staff', async () => {
    auth.state = { user: { role: 'moderator' }, isLoading: false };
    await renderGuard();
    expect(bodyText()).toContain('Login page');
    expect(bodyText()).not.toContain('Admin panel');
  });

  it('has no loading state of its own: it decides on the user alone (App shows the spinner before it)', async () => {
    // A session check still running leaves no user yet; the guard redirects at
    // once and renders neither the children nor a spinner. App.tsx mounts the
    // guard only after its own loading screen.
    auth.state = { user: null, isLoading: true };
    await renderGuard();
    expect(bodyText()).toContain('Login page');
    expect(bodyText()).not.toContain('Admin panel');
  });
});
