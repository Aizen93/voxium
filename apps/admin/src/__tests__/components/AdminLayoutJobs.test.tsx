import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, click, getByRole, bodyText, type Mounted } from '../helpers/dom';

/** The navigation has a "Jobs" entry, and it opens the Jobs page (each page is a stub here). */

vi.mock('../../stores/authStore', () => ({
  useAuthStore: () => ({ logout: vi.fn(), user: { username: 'root', role: 'superadmin' } }),
}));
vi.mock('../../stores/adminStore', () => ({ useAdminStore: Object.assign(() => ({}), { getState: () => ({ clearSelectedUser: vi.fn() }) }) }));
vi.mock('../../components/AdminDashboard', () => ({ AdminDashboard: () => <p>dashboard page</p> }));
vi.mock('../../components/AdminUserList', () => ({ AdminUserList: () => null }));
vi.mock('../../components/AdminUserDetail', () => ({ AdminUserDetail: () => null }));
vi.mock('../../components/AdminServerList', () => ({ AdminServerList: () => null }));
vi.mock('../../components/AdminBanList', () => ({ AdminBanList: () => null }));
vi.mock('../../components/AdminStorage', () => ({ AdminStorage: () => null }));
vi.mock('../../components/AdminDataTools', () => ({ AdminDataTools: () => null }));
vi.mock('../../components/AdminAuditLog', () => ({ AdminAuditLog: () => null }));
vi.mock('../../components/AdminAnnouncements', () => ({ AdminAnnouncements: () => null }));
vi.mock('../../components/AdminReports', () => ({ AdminReports: () => null }));
vi.mock('../../components/AdminSupportTickets', () => ({ AdminSupportTickets: () => null }));
vi.mock('../../components/AdminRateLimits', () => ({ AdminRateLimits: () => null }));
vi.mock('../../components/AdminFeatureFlags', () => ({ AdminFeatureFlags: () => null }));
vi.mock('../../components/AdminGeography', () => ({ AdminGeography: () => null }));
vi.mock('../../components/AdminJobs', () => ({ AdminJobs: () => <p>jobs page</p> }));

import { AdminLayout } from '../../components/AdminLayout';

let view: Mounted;
beforeEach(() => {
  window.location.hash = '';
  view = mount();
});
afterEach(() => {
  view.unmount();
  window.location.hash = '';
});

describe('AdminLayout — the Jobs entry', () => {
  it('lists Jobs in the navigation and opens the Jobs page with its own address', async () => {
    await view.render(<AdminLayout />);
    expect(bodyText()).toContain('dashboard page');
    await click(getByRole('button', 'Jobs'));
    expect(bodyText()).toContain('jobs page');
    expect(window.location.hash).toBe('#jobs');
  });

  it('opens the Jobs page from its address', async () => {
    window.location.hash = '#jobs';
    await view.render(<AdminLayout />);
    expect(bodyText()).toContain('jobs page');
  });
});
