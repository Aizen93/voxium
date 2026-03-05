import type { Page } from '@playwright/test';

const API_URL = 'http://localhost:3001/api/v1';

/** Unique suffix for test isolation — avoids collisions across runs. */
export function uniqueId() {
  return Math.random().toString(36).slice(2, 8);
}

/** Generate a test user object with unique credentials. */
export function testUser(prefix = 'user') {
  const id = uniqueId();
  return {
    username: `${prefix}${id}`,
    email: `${prefix}${id}@test.local`,
    password: 'TestPass123!',
  };
}

/** Register and login via the UI. Waits for the main layout to appear. */
export async function registerViaUI(
  page: Page,
  user: { username: string; email: string; password: string },
) {
  await page.goto('/register');
  await page.getByPlaceholder('Pick a username').fill(user.username);
  await page.getByPlaceholder('you@example.com').fill(user.email);
  await page.getByPlaceholder('At least 8 characters').fill(user.password);
  await page.getByRole('button', { name: 'Create Account' }).click();
  // Wait for redirect to main layout (presence of server sidebar or DM area)
  await page.waitForURL('/', { timeout: 15_000 });
}

/** Login via the UI. Waits for the main layout to appear. */
export async function loginViaUI(
  page: Page,
  user: { email: string; password: string },
) {
  await page.goto('/login');
  await page.getByPlaceholder('you@example.com').fill(user.email);
  await page.getByPlaceholder('Your password').fill(user.password);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await page.waitForURL('/', { timeout: 15_000 });
}

/**
 * Inject auth tokens into localStorage so the page starts authenticated.
 * Faster than going through the UI for setup steps.
 */
export async function injectAuth(
  page: Page,
  tokens: { accessToken: string; refreshToken: string; user: { id: string; username: string } },
) {
  await page.goto('/login'); // Need a page loaded to set localStorage
  await page.evaluate((t) => {
    localStorage.setItem('voxium_access_token', t.accessToken);
    localStorage.setItem('voxium_refresh_token', t.refreshToken);
  }, tokens);
  await page.goto('/');
  // Wait for the app to hydrate with auth
  await page.waitForURL('/', { timeout: 15_000 });
}
