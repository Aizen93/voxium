import { test, expect } from './helpers/fixtures';
import { testUser, registerViaUI, registerViaUIUnverified, loginViaUI } from './helpers/auth';
import { registerUser } from './helpers/api';
import { dmHeading } from './helpers/selectors';

test.describe('Authentication', () => {
  test('register a new account', async ({ page }) => {
    const user = testUser('reg');
    await registerViaUIUnverified(page, user);
    // New registrations land on verification pending page (email not yet verified)
    await expect(page.getByText('Verify your email')).toBeVisible({ timeout: 10_000 });
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
    // Consent is required before the form submits at all (CNIL/GDPR) — the
    // duplicate-username error is a SERVER answer, reachable only past it
    await page.getByLabel(/Terms of Service/).check();
    await page.getByLabel(/Privacy Policy/).check();
    await page.getByRole('button', { name: 'Create Account' }).click();

    await expect(page.locator('.text-vox-accent-danger')).toBeVisible({ timeout: 5_000 });
  });

  test('register refuses to submit until both legal documents are accepted', async ({ page }) => {
    const user = testUser('consent');
    await page.goto('/register');
    await page.getByPlaceholder('Pick a username').fill(user.username);
    await page.getByPlaceholder('you@example.com').fill(user.email);
    await page.getByPlaceholder('At least 8 characters').fill(user.password);

    const submit = page.getByRole('button', { name: 'Create Account' });
    await expect(submit).toBeDisabled();
    await page.getByLabel(/Terms of Service/).check();
    await expect(submit).toBeDisabled(); // one of two is not consent
    await page.getByLabel(/Privacy Policy/).check();
    await expect(submit).toBeEnabled();

    // The documents open in place — the half-filled form must survive
    await page.getByRole('button', { name: 'Privacy Policy' }).click();
    await expect(page.getByTestId('legal-doc-privacy')).toBeVisible();
    await page.getByTestId('legal-doc-privacy').getByRole('button', { name: 'Close' }).first().click();
    await expect(page.getByTestId('legal-doc-privacy')).toBeHidden();
    await expect(page.getByPlaceholder('Pick a username')).toHaveValue(user.username);
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
