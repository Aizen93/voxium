import type { Page } from '@playwright/test';
import { setLatestPendingRegistrationCodeForEmail, TEST_SIGNUP_CODE } from './db';

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

/** The code step's input (shown once the server accepted the registration form). */
export function signupCodeInput(page: Page) {
  return page.getByLabel('Sign-up code', { exact: true });
}

/**
 * Fill and submit the registration form, then wait for the code step: the
 * server answered 202 and nothing exists yet but a pending registration.
 */
export async function startRegistrationViaUI(
  page: Page,
  user: { username: string; email: string; password: string },
) {
  await page.goto('/register');
  await page.getByPlaceholder('Pick a username').fill(user.username);
  await page.getByPlaceholder('you@example.com').fill(user.email);
  await page.getByPlaceholder('At least 8 characters').fill(user.password);
  await page.getByLabel(/Terms of Service/).check();
  await page.getByLabel(/Privacy Policy/).check();
  await page.getByRole('button', { name: 'Create Account' }).click();
  await signupCodeInput(page).waitFor({ timeout: 15_000 });
}

/**
 * On the code step: make the known test code the valid one for this address
 * (the pending id never reaches the UI, so the newest pending row for the
 * e-mail), type it and submit.
 */
export async function submitKnownSignupCode(page: Page, email: string) {
  await setLatestPendingRegistrationCodeForEmail(email, TEST_SIGNUP_CODE);
  await signupCodeInput(page).fill(TEST_SIGNUP_CODE);
  await page.getByRole('button', { name: 'Verify and create account' }).click();
}

/**
 * Register via the UI: the form, the code step with the known code, then the
 * main layout (the account is created verified, so no verification gate).
 */
export async function registerViaUI(
  page: Page,
  user: { username: string; email: string; password: string },
) {
  await startRegistrationViaUI(page, user);
  await submitKnownSignupCode(page, user.email);
  await page.waitForURL('/', { timeout: 15_000 });
  await page.getByRole('heading', { name: 'Direct Messages' }).first().waitFor({ timeout: 10_000 });
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
