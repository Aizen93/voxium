import { test, expect } from './helpers/fixtures';
import { testUser, injectAuth } from './helpers/auth';
import { registerUser } from './helpers/api';
import { dmHeading } from './helpers/selectors';

test.describe('Auth edge cases', () => {
  test('expired/invalid token redirects to login', async ({ page }) => {
    await page.goto('/login');
    await page.evaluate(() => {
      localStorage.setItem('voxium_access_token', 'invalid.token.here');
      localStorage.setItem('voxium_refresh_token', 'invalid.refresh.here');
    });
    await page.goto('/');

    await page.waitForURL(/\/login/, { timeout: 15_000 });
    await expect(page.getByText('Welcome back!')).toBeVisible();
  });

  test('unauthenticated user sees landing page or login', async ({ page }) => {
    await page.goto('/login');
    await page.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
    });

    await page.goto('/');
    await expect(dmHeading(page)).not.toBeVisible({ timeout: 5_000 });
  });

  test('logout clears session and redirects', async ({ page, request }) => {
    const user = testUser('logout');
    const data = await registerUser(request, user);
    await injectAuth(page, data);

    await expect(dmHeading(page)).toBeVisible({ timeout: 10_000 });

    await page.locator('button[title="Logout"]').click();

    // In browser mode, logout redirects to / which shows the landing page
    await expect(dmHeading(page)).not.toBeVisible({ timeout: 10_000 });

    const hasToken = await page.evaluate(() => !!localStorage.getItem('voxium_access_token'));
    expect(hasToken).toBe(false);
  });
});
