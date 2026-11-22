// Sign-in sessions: every sign-in of an account is a session of its own, the
// list in Settings > Security shows them, and ending one (from another device,
// or by signing out) makes the server refuse its refresh token.
//
// Two devices of one account are two browser CONTEXTS, each with its OWN
// sign-in (`injectSeparateSignIn`): one pair injected into two contexts would
// be one session presented from two places. A context is also what keeps the
// accounts' tabs apart (one tab per account per browser runs the app).
import type { APIRequestContext, Browser, BrowserContext, Page } from '@playwright/test';
import { test, expect } from './helpers/fixtures';
import { testUser, injectSeparateSignIn } from './helpers/auth';
import { registerUser, loginUser, API_URL } from './helpers/api';
import { dmHeading, logoutButton } from './helpers/selectors';

type Account = { username: string; email: string; password: string };

const SIGNED_OUT_ELSEWHERE = 'You were signed out from another device.';

/** The refresh token the page's storage holds right now. */
const storedRefreshToken = (page: Page) =>
  page.evaluate(() => localStorage.getItem('voxium_refresh_token'));

/** `POST /auth/refresh` with `refreshToken`: the raw status. */
async function refreshStatus(request: APIRequestContext, refreshToken: string) {
  const res = await request.post(`${API_URL}/auth/refresh`, { data: { refreshToken } });
  return res.status();
}

type Device = { context: BrowserContext; page: Page; refreshToken: string };

/** A new browser context signed in with a session of its own, the app loaded. */
async function openDevice(browser: Browser, request: APIRequestContext, account: Account): Promise<Device> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await injectSeparateSignIn(page, request, account);
  await expect(dmHeading(page)).toBeVisible({ timeout: 20_000 });
  const refreshToken = await storedRefreshToken(page);
  expect(refreshToken, 'the context holds its own refresh token').toBeTruthy();
  return { context, page, refreshToken: refreshToken as string };
}

/**
 * The account, registered through the API. Registering signs it in, which is
 * a session too: it is ended here, so the sessions a test lists are the
 * devices the test opened and nothing else.
 */
async function newAccount(request: APIRequestContext, prefix: string): Promise<Account> {
  const account = testUser(prefix);
  const registered = await registerUser(request, account);
  const out = await request.post(`${API_URL}/auth/logout`, { data: { refreshToken: registered.refreshToken } });
  expect(out.status()).toBe(204);
  return account;
}

/** Settings > Security, with the sessions list loaded. */
async function openSessions(page: Page) {
  await page.locator('button[title="Settings"]').last().click();
  await page.getByRole('button', { name: 'Security', exact: true }).click();
  await expect(page.getByTestId('sessions-section')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('session-row').first()).toBeVisible({ timeout: 15_000 });
}

/** The page of a device that was signed out from elsewhere: the sign-in page with the reason. */
async function expectSignedOutElsewhere(page: Page) {
  await expect(page).toHaveURL(/\/login\?reason=signed-out-elsewhere/, { timeout: 30_000 });
  await expect(page.getByTestId('login-reason')).toHaveText(SIGNED_OUT_ELSEWHERE, { timeout: 15_000 });
}

/** Type the password in the confirmation dialog and submit. */
async function confirmWithPassword(page: Page, password: string) {
  await expect(page.getByTestId('sessions-confirm-dialog')).toBeVisible();
  await page.getByTestId('sessions-confirm-password').fill(password);
  await page.getByTestId('sessions-confirm-submit').click();
}

test.describe('sign-in sessions', () => {
  test('the list shows this device first, marked, without a sign-out button, and the other session', async ({ browser, request }) => {
    test.setTimeout(120_000);
    const account = await newAccount(request, 'sesl');
    const a = await openDevice(browser, request, account);
    const b = await openDevice(browser, request, account);
    try {
      await openSessions(a.page);

      const rows = a.page.getByTestId('session-row');
      await expect(rows).toHaveCount(2);
      await expect(a.page.getByTestId('session-this-device')).toHaveCount(1);
      await expect(a.page.locator('[data-testid="session-row"][data-session-current="true"]')).toHaveCount(1);

      // this device is first, carries the mark and has no sign-out button
      const first = rows.nth(0);
      await expect(first).toHaveAttribute('data-session-current', 'true');
      await expect(first.getByTestId('session-this-device')).toBeVisible();
      await expect(first.getByTestId('session-sign-out')).toHaveCount(0);

      // the other one can be signed out
      const second = rows.nth(1);
      await expect(second).toHaveAttribute('data-session-current', 'false');
      await expect(second.getByTestId('session-this-device')).toHaveCount(0);
      await expect(second.getByTestId('session-sign-out')).toBeVisible();
    } finally {
      await a.context.close();
      await b.context.close();
    }
  });

  test('signing one other session out: a wrong password is refused, the right one ends it and B lands on the sign-in page', async ({ browser, request }) => {
    test.setTimeout(120_000);
    const account = await newAccount(request, 'ses1');
    const a = await openDevice(browser, request, account);
    const b = await openDevice(browser, request, account);
    try {
      expect(b.refreshToken).not.toBe(a.refreshToken);
      await openSessions(a.page);
      await expect(a.page.getByTestId('session-row')).toHaveCount(2);

      await a.page.locator('[data-testid="session-row"][data-session-current="false"]').getByTestId('session-sign-out').click();

      // a wrong password keeps the dialog open, with the error
      await confirmWithPassword(a.page, 'NotThePassword123!');
      await expect(a.page.getByTestId('sessions-confirm-error')).toBeVisible({ timeout: 15_000 });
      await expect(a.page.getByTestId('sessions-confirm-dialog')).toBeVisible();

      // the right one closes it
      await a.page.getByTestId('sessions-confirm-password').fill(account.password);
      await a.page.getByTestId('sessions-confirm-submit').click();
      await expect(a.page.getByTestId('sessions-confirm-dialog')).toHaveCount(0, { timeout: 15_000 });

      // B is on the sign-in page with the reason, and its token is refused
      await expectSignedOutElsewhere(b.page);
      expect(await refreshStatus(request, b.refreshToken)).toBe(401);

      // A still works, and its list now shows the one row
      await expect(a.page.getByTestId('session-row')).toHaveCount(1, { timeout: 15_000 });
      await expect(a.page.getByTestId('session-row').first()).toHaveAttribute('data-session-current', 'true');
      await expect(dmHeading(a.page)).toBeVisible();
    } finally {
      await a.context.close();
      await b.context.close();
    }
  });

  test('signing every other session out leaves this one signed in, on a pair that renews', async ({ browser, request }) => {
    test.setTimeout(150_000);
    const account = await newAccount(request, 'sesa');
    const a = await openDevice(browser, request, account);
    const b = await openDevice(browser, request, account);
    const c = await openDevice(browser, request, account);
    try {
      await openSessions(a.page);
      await expect(a.page.getByTestId('session-row')).toHaveCount(3);

      await a.page.getByTestId('sessions-sign-out-others').click();
      await confirmWithPassword(a.page, account.password);
      await expect(a.page.getByTestId('sessions-confirm-dialog')).toHaveCount(0, { timeout: 15_000 });

      await expectSignedOutElsewhere(b.page);
      await expectSignedOutElsewhere(c.page);
      expect(await refreshStatus(request, b.refreshToken)).toBe(401);
      expect(await refreshStatus(request, c.refreshToken)).toBe(401);

      // A stays; the list shows only it
      await expect(a.page.getByTestId('session-row')).toHaveCount(1, { timeout: 15_000 });
      await expect(dmHeading(a.page)).toBeVisible();

      // the operation replaced A's own pair: the old token is refused, the one A holds now renews
      expect(await refreshStatus(request, a.refreshToken)).toBe(401);
      const current = await storedRefreshToken(a.page);
      expect(current, 'A holds a refresh token').toBeTruthy();
      expect(current).not.toBe(a.refreshToken);
      expect(await refreshStatus(request, current as string)).toBe(200);
    } finally {
      await a.context.close();
      await b.context.close();
      await c.context.close();
    }
  });

  test('signing out ends the session on the server and leaves the other sign-in alone', async ({ browser, request }) => {
    test.setTimeout(120_000);
    const account = await newAccount(request, 'sesx');
    const a = await openDevice(browser, request, account);
    const b = await openDevice(browser, request, account);
    try {
      const loggedOut = a.page.waitForResponse(
        (r) => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith('/auth/logout'),
        { timeout: 20_000 },
      );
      await logoutButton(a.page).click();
      const res = await loggedOut;
      expect(res.status()).toBe(204);
      // signing out shows the landing page: the session is gone from the storage
      await expect.poll(() => storedRefreshToken(a.page), { timeout: 15_000 }).toBeNull();

      expect(await refreshStatus(request, a.refreshToken)).toBe(401);

      // B is a session of its own: still signed in, and its token still renews
      await expect(dmHeading(b.page)).toBeVisible();
      const current = await storedRefreshToken(b.page);
      expect(await refreshStatus(request, current as string)).toBe(200);
    } finally {
      await a.context.close();
      await b.context.close();
    }
  });

  test('every refresh returns a new token, the replaced one is still answered in the grace window, and a sign-out ends them all', async ({ request }) => {
    const account = await newAccount(request, 'sesr');
    const first = await loginUser(request, account);

    const res = await request.post(`${API_URL}/auth/refresh`, { data: { refreshToken: first.refreshToken } });
    expect(res.status()).toBe(200);
    const renewed = ((await res.json()) as { data: { refreshToken: string } }).data.refreshToken;
    expect(renewed).toBeTruthy();
    expect(renewed).not.toBe(first.refreshToken);

    // the replaced token, presented again right away, is still answered
    expect(await refreshStatus(request, first.refreshToken)).toBe(200);

    // the current token ends the session; every token of it is refused after
    const out = await request.post(`${API_URL}/auth/logout`, { data: { refreshToken: renewed } });
    expect(out.status()).toBe(204);
    expect(await refreshStatus(request, renewed)).toBe(401);
    expect(await refreshStatus(request, first.refreshToken)).toBe(401);
  });
});
