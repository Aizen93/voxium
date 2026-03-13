import { test, expect } from './helpers/fixtures';
import { testUser } from './helpers/auth';
import { API_URL, registerUser, registerUserUnverified, loginUser } from './helpers/api';
import { createVerificationToken, expireVerificationToken, verifyUserEmail, disconnectDb } from './helpers/db';

test.afterAll(async () => {
  await disconnectDb();
});

test.describe('Email Verification', () => {
  test('unverified user sees verification pending page', async ({ page, request }) => {
    const user = testUser('unv');
    const data = await registerUserUnverified(request, user);

    // Inject auth tokens — user is authenticated but not verified
    await page.goto('/login');
    await page.evaluate((t) => {
      localStorage.setItem('voxium_access_token', t.accessToken);
      localStorage.setItem('voxium_refresh_token', t.refreshToken);
    }, data);
    await page.goto('/');

    // Should see the verification pending page, not the main layout
    await expect(page.getByText('Verify your email')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(user.email)).toBeVisible();
    await expect(page.getByRole('button', { name: /Resend verification email/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible();
  });

  test('unverified user cannot access protected API routes', async ({ request }) => {
    const user = testUser('apib');
    const data = await registerUserUnverified(request, user);

    // Try to create a server — should be blocked by requireVerifiedEmail
    const res = await request.post(`${API_URL}/servers`, {
      data: { name: 'Test Server' },
      headers: { Authorization: `Bearer ${data.accessToken}` },
    });

    expect(res.status()).toBe(403);
    const body = await res.json();
    expect(body.error).toContain('Email not verified');
  });

  test('resend verification email shows success message', async ({ page, request }) => {
    const user = testUser('rsnd');
    const data = await registerUserUnverified(request, user);

    await page.goto('/login');
    await page.evaluate((t) => {
      localStorage.setItem('voxium_access_token', t.accessToken);
      localStorage.setItem('voxium_refresh_token', t.refreshToken);
    }, data);
    await page.goto('/');

    await expect(page.getByText('Verify your email')).toBeVisible({ timeout: 10_000 });

    // Click resend button
    await page.getByRole('button', { name: /Resend verification email/ }).click();

    // Should show success message and cooldown
    await expect(page.getByText('Verification email sent!')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/Resend in \d+s/)).toBeVisible();
  });

  test('verify email via token link', async ({ page, request }) => {
    const user = testUser('vfy');
    const data = await registerUserUnverified(request, user);

    // Get a verification token from the DB
    const rawToken = await createVerificationToken(data.user.id);

    // Visit the verification link
    await page.goto(`/verify-email/${rawToken}`);

    // Should show success
    await expect(page.getByText('Your email has been verified successfully!')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Go to Login')).toBeVisible();
  });

  test('verified user can access the app after verification', async ({ page, request }) => {
    const user = testUser('vacc');
    const data = await registerUserUnverified(request, user);

    // Inject auth tokens
    await page.goto('/login');
    await page.evaluate((t) => {
      localStorage.setItem('voxium_access_token', t.accessToken);
      localStorage.setItem('voxium_refresh_token', t.refreshToken);
    }, data);
    await page.goto('/');

    // Should see verification pending page first
    await expect(page.getByText('Verify your email')).toBeVisible({ timeout: 10_000 });

    // Verify the email via DB
    await verifyUserEmail(data.user.id);

    // Reload — user should now see the main layout
    await page.reload();
    await expect(page.getByText('Direct Messages', { exact: true }).first()).toBeVisible({ timeout: 10_000 });
  });

  test('invalid verification token shows error', async ({ page }) => {
    await page.goto('/verify-email/invalidtoken1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef');

    await expect(page.getByText('Invalid or expired verification link')).toBeVisible({ timeout: 10_000 });
  });

  test('expired verification token shows error', async ({ page, request }) => {
    const user = testUser('exp');
    const data = await registerUserUnverified(request, user);

    // Create a token then expire it
    const rawToken = await createVerificationToken(data.user.id);
    await expireVerificationToken(data.user.id);

    await page.goto(`/verify-email/${rawToken}`);

    await expect(page.getByText('Invalid or expired verification link')).toBeVisible({ timeout: 10_000 });
  });

  test('email login is case-insensitive', async ({ request }) => {
    const user = testUser('case');

    // Register with lowercase email
    await registerUser(request, user);

    // Login with uppercase email — should succeed
    const upperEmail = user.email.toUpperCase();
    const data = await loginUser(request, { email: upperEmail, password: user.password });
    expect(data.accessToken).toBeTruthy();
    expect(data.user.username).toBe(user.username);
  });

  test('unverified user cannot access invite page', async ({ page, request }) => {
    const user = testUser('inv');
    const data = await registerUserUnverified(request, user);

    await page.goto('/login');
    await page.evaluate((t) => {
      localStorage.setItem('voxium_access_token', t.accessToken);
      localStorage.setItem('voxium_refresh_token', t.refreshToken);
    }, data);

    // Try to access an invite page — should show verification pending, not invite
    await page.goto('/invite/somecode');
    await expect(page.getByText('Verify your email')).toBeVisible({ timeout: 10_000 });
  });

  test('logout from verification page redirects to login', async ({ page, request }) => {
    const user = testUser('vlo');
    const data = await registerUserUnverified(request, user);

    await page.goto('/login');
    await page.evaluate((t) => {
      localStorage.setItem('voxium_access_token', t.accessToken);
      localStorage.setItem('voxium_refresh_token', t.refreshToken);
    }, data);
    await page.goto('/');

    await expect(page.getByText('Verify your email')).toBeVisible({ timeout: 10_000 });

    // Click logout
    await page.getByRole('button', { name: 'Log out' }).click();

    // Should redirect to login
    await expect(page.getByText('Welcome back!')).toBeVisible({ timeout: 10_000 });

    // Tokens should be cleared
    const token = await page.evaluate(() => localStorage.getItem('voxium_access_token'));
    expect(token).toBeNull();
  });
});
