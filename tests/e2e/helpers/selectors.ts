import type { Page } from '@playwright/test';

/** Locator for the "Direct Messages" heading in the sidebar (confirms main layout loaded). */
export function dmHeading(page: Page) {
  return page.getByRole('heading', { name: 'Direct Messages' }).first();
}
