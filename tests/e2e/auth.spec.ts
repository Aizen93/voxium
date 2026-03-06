import { test, expect } from './helpers/fixtures';
import { testUser, registerViaUI, loginViaUI } from './helpers/auth';
import { registerUser } from './helpers/api';
import { dmHeading } from './helpers/selectors';

test.describe('Authentication', () => {
  test('register a new account', async ({ page }) => {
    const user = testUser('reg');
    await registerViaUI(page, user);
    await expect(dmHeading(page)).toBeVisible({ timeout: 10_000 });
  });

  test('login with existing account', async ({ page, request }) => {
    const user = testUser('login');
    await registerUser(request, user);

    await loginViaUI(page, user);
    await expect(dmHeading(page)).toBeVisible({ timeout: 10_000 });
  });

  test('login with wrong password shows error', async ({ page, request }) => {
    const user = testUser('bad');
    await registerUser(request, user);

    await page.goto('/login');
    await page.getByPlaceholder('you@example.com').fill(user.email);
    await page.getByPlaceholder('Your password').fill('wrongpassword123');
    await page.getByRole('button', { name: 'Sign In' }).click();

    await expect(page.locator('.text-vox-accent-danger')).toBeVisible({ timeout: 5_000 });
  });

  test('register with duplicate username shows error', async ({ page, request }) => {
    const user = testUser('dup');
    await registerUser(request, user);

    await page.goto('/register');
    await page.getByPlaceholder('Pick a username').fill(user.username);
    await page.getByPlaceholder('you@example.com').fill(`other${user.email}`);
    await page.getByPlaceholder('At least 8 characters').fill(user.password);
    await page.getByRole('button', { name: 'Create Account' }).click();

    await expect(page.locator('.text-vox-accent-danger')).toBeVisible({ timeout: 5_000 });
  });

  test('navigate between login and register', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByText('Welcome back!')).toBeVisible();

    await page.getByText('Create one').click();
    await expect(page.getByText('Create an account')).toBeVisible();

    await page.getByText('Sign in').click();
    await expect(page.getByText('Welcome back!')).toBeVisible();
  });
});
