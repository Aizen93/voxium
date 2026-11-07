import type { Page } from '@playwright/test';

/** Locator for the "Direct Messages" heading in the sidebar (confirms main layout loaded). */
export function dmHeading(page: Page) {
  return page.getByRole('heading', { name: 'Direct Messages' }).first();
}

/** The user card's logout button (an icon button named by its title, `common.logout`). */
export function logoutButton(page: Page) {
  return page.locator('button[title="Log out"]');
}
