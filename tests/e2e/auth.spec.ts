import { test, expect } from './helpers/fixtures';
import {
  testUser, loginViaUI, startRegistrationViaUI, submitKnownSignupCode, signupCodeInput,
} from './helpers/auth';
import { API_URL, registerUser } from './helpers/api';
import { setLatestPendingRegistrationCodeForEmail } from './helpers/db';
import { dmHeading } from './helpers/selectors';

test.describe('Authentication', () => {
  test('register a new account', async ({ page }) => {
    const user = testUser('reg');
    await startRegistrationViaUI(page, user);

    // The code step: nothing is created until the mailed code comes back
    await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible();
    await expect(page.getByText(user.email).first()).toBeVisible();
    await expect(signupCodeInput(page)).toBeVisible();
    // One resend, and only after a delay: disabled with its countdown at first
    await expect(page.getByRole('button', { name: /Send a new code/ })).toBeDisabled();
    await expect(page.getByRole('link', { name: /sign in/i }).first()).toHaveAttribute('href', /\/login$/);

    await submitKnownSignupCode(page, user.email);

    // Verified from the start: straight into the app, no verification gate
    await page.waitForURL('/', { timeout: 15_000 });
    await expect(dmHeading(page)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Verify your email')).toBeHidden();
  });

  test('a wrong sign-up code is refused and the account is not created', async ({ page, request }) => {
    const user = testUser('regbad');
    await startRegistrationViaUI(page, user);
    // The known code is the valid one; any other is wrong
    await setLatestPendingRegistrationCodeForEmail(user.email);

    await signupCodeInput(page).fill('000000');
    await page.getByRole('button', { name: 'Verify and create account' }).click();
    await expect(page.getByText('Invalid or expired code')).toBeVisible({ timeout: 10_000 });
    await expect(signupCodeInput(page)).toBeVisible();

    // No account behind the address yet
    const login = await request.post(`${API_URL}/auth/login`, {
      data: { email: user.email, password: user.password },
    });
    expect(login.ok()).toBe(false);
  });

  test('a username taken during the code step can be replaced with the same code', async ({ page, request }) => {
    const user = testUser('regtk');
    await startRegistrationViaUI(page, user);

    // Someone else completes a registration with that username meanwhile
    await registerUser(request, { ...testUser('regtko'), username: user.username });

    await submitKnownSignupCode(page, user.email);
    const usernameField = page.getByPlaceholder('Pick a username');
    await expect(usernameField).toBeVisible({ timeout: 10_000 });

    // A new name, the same code (a taken username costs no attempt)
    await usernameField.fill(`${user.username}x`);
    await page.getByRole('button', { name: 'Verify and create account' }).click();
    await page.waitForURL('/', { timeout: 15_000 });
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
