import * as OTPAuth from 'otpauth';
import { createClient } from 'redis';
import { test, expect } from './helpers/fixtures';
import { testUser } from './helpers/auth';
import { API_URL, registerUser } from './helpers/api';
import { dmHeading } from './helpers/selectors';

/** Clear all rate limit keys in Redis */
async function clearRateLimits() {
  const redis = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
  await redis.connect();
  const keys: string[] = [];
  for await (const key of redis.scanIterator({ MATCH: 'rl:*', COUNT: 100 })) {
    if (key !== 'rl:config') keys.push(key);
  }
  if (keys.length > 0) await redis.del(keys);
  await redis.quit().catch(() => {});
}

/** Generate a valid TOTP code from a base32 secret */
function generateTOTP(secret: string): string {
  const totp = new OTPAuth.TOTP({
    issuer: 'Voxium',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret),
  });
  return totp.generate();
}

/** Setup and enable TOTP for a user via the API. Returns the secret and backup codes. */
async function enableTOTPForUser(
  request: import('@playwright/test').APIRequestContext,
  token: string,
) {
  // Step 1: Setup — get secret
  const setupRes = await request.post(`${API_URL}/auth/totp/setup`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(setupRes.ok()).toBe(true);
  const { data: setupData } = await setupRes.json();
  const secret: string = setupData.secret;

  // Step 2: Enable — verify with a real TOTP code
  const code = generateTOTP(secret);
  const enableRes = await request.post(`${API_URL}/auth/totp/enable`, {
    data: { code },
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(enableRes.ok()).toBe(true);
  const { data: enableData } = await enableRes.json();

  return { secret, backupCodes: enableData.backupCodes as string[] };
}

test.describe('TOTP Two-Factor Authentication', () => {
  test.beforeEach(async () => {
    await clearRateLimits();
  });

  test('login with TOTP enabled requires verification code', async ({ page, request }) => {
    const user = testUser('totp');
    const data = await registerUser(request, user);

    // Enable TOTP via API
    const { secret } = await enableTOTPForUser(request, data.accessToken);

    // Try logging in via UI
    await page.goto('/login');
    await page.getByPlaceholder('you@example.com').fill(user.email);
    await page.getByPlaceholder('Your password').fill(user.password);
    await page.getByRole('button', { name: 'Sign In' }).click();

    // Should see TOTP verification step
    await expect(page.getByText('Two-Factor Authentication')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByPlaceholder('000000')).toBeVisible();

    // Enter valid TOTP code
    const code = generateTOTP(secret);
    await page.getByPlaceholder('000000').fill(code);
    await page.getByRole('button', { name: 'Verify' }).click();

    // Should be authenticated
    await expect(dmHeading(page)).toBeVisible({ timeout: 10_000 });
  });

  test('wrong TOTP code shows error', async ({ page, request }) => {
    const user = testUser('totpbad');
    const data = await registerUser(request, user);
    await enableTOTPForUser(request, data.accessToken);

    await page.goto('/login');
    await page.getByPlaceholder('you@example.com').fill(user.email);
    await page.getByPlaceholder('Your password').fill(user.password);
    await page.getByRole('button', { name: 'Sign In' }).click();

    await expect(page.getByText('Two-Factor Authentication')).toBeVisible({ timeout: 5_000 });

    // Enter invalid code
    await page.getByPlaceholder('000000').fill('000000');
    await page.getByRole('button', { name: 'Verify' }).click();

    // Should show error
    await expect(page.locator('.text-vox-accent-danger')).toBeVisible({ timeout: 5_000 });
  });

  test('backup code works for login', async ({ page, request }) => {
    const user = testUser('totpbk');
    const data = await registerUser(request, user);
    const { backupCodes } = await enableTOTPForUser(request, data.accessToken);

    await page.goto('/login');
    await page.getByPlaceholder('you@example.com').fill(user.email);
    await page.getByPlaceholder('Your password').fill(user.password);
    await page.getByRole('button', { name: 'Sign In' }).click();

    await expect(page.getByText('Two-Factor Authentication')).toBeVisible({ timeout: 5_000 });

    // Enter a backup code
    await page.getByPlaceholder('000000').fill(backupCodes[0]);
    await page.getByRole('button', { name: 'Verify' }).click();

    // Should be authenticated
    await expect(dmHeading(page)).toBeVisible({ timeout: 10_000 });
  });

  test('trusted device token bypasses TOTP on next login', async ({ page, request }) => {
    const user = testUser('totptd');
    const data = await registerUser(request, user);
    const { secret } = await enableTOTPForUser(request, data.accessToken);

    // First login: go through TOTP
    await page.goto('/login');
    await page.getByPlaceholder('you@example.com').fill(user.email);
    await page.getByPlaceholder('Your password').fill(user.password);
    await page.getByRole('button', { name: 'Sign In' }).click();

    await expect(page.getByText('Two-Factor Authentication')).toBeVisible({ timeout: 5_000 });
    const code = generateTOTP(secret);
    await page.getByPlaceholder('000000').fill(code);
    await page.getByRole('button', { name: 'Verify' }).click();
    await expect(dmHeading(page)).toBeVisible({ timeout: 10_000 });

    // Verify trusted device token was stored
    const hasTrustedToken = await page.evaluate(() => !!localStorage.getItem('voxium_trusted_device'));
    expect(hasTrustedToken).toBe(true);

    // Logout (trusted device token should persist)
    await page.locator('button[title="Logout"]').click();

    // Second login: should skip TOTP entirely
    await page.goto('/login');
    await page.getByPlaceholder('you@example.com').fill(user.email);
    await page.getByPlaceholder('Your password').fill(user.password);
    await page.getByRole('button', { name: 'Sign In' }).click();

    // Should go straight to main layout, no TOTP prompt
    await expect(dmHeading(page)).toBeVisible({ timeout: 10_000 });
  });

  test('cancel TOTP returns to login form', async ({ page, request }) => {
    const user = testUser('totpcan');
    const data = await registerUser(request, user);
    await enableTOTPForUser(request, data.accessToken);

    await page.goto('/login');
    await page.getByPlaceholder('you@example.com').fill(user.email);
    await page.getByPlaceholder('Your password').fill(user.password);
    await page.getByRole('button', { name: 'Sign In' }).click();

    await expect(page.getByText('Two-Factor Authentication')).toBeVisible({ timeout: 5_000 });

    // Click back
    await page.getByText('Back to login').click();

    // Should be back on login form
    await expect(page.getByText('Welcome back!')).toBeVisible({ timeout: 5_000 });
  });
});
