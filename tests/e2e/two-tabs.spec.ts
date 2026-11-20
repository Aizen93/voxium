// One tab of an account owns its encrypted vault (docs/e2e-dm-spec.md §7.4).
//
// Two pages of ONE browser context are two tabs of the same browser: they
// share its storage (the session in localStorage, the IndexedDB vault), its
// Web Locks and its BroadcastChannels. Every other spec gives each user a
// context of their own, so none of them opens a second tab of an account;
// this one does. The second tab shows a screen instead of the app, takes the
// vault over on "Use it here" (the first tab then shows that it gave it up),
// and the account sends and reads end-to-end encrypted messages from it
// afterwards. A tab waiting on that screen takes the vault over by itself
// when the owning tab closes, and leaves it to the owning tab when that one
// reloads while the waiting tab is in the background.
//
// Visibility: in the headless Chromium these specs run on, every page of a
// context reports `document.visibilityState === 'visible'`, the page behind
// as well as the one in front, before and after `bringToFront()` (measured
// with Playwright 1.65). A tab in the background is therefore emulated where
// a test needs one (`asBackgroundTab`): its document reports `hidden` from
// its first script on, as a tab behind another does, and never changes.
import type { APIRequestContext, BrowserContext, Page } from '@playwright/test';
import { test, expect } from './helpers/fixtures';
import { testUser, injectAuth } from './helpers/auth';
import { registerUser, sendFriendRequest, acceptFriendRequest, API_URL } from './helpers/api';
import { dmHeading } from './helpers/selectors';

const BLOCKED_TITLE = 'Voxium is open in another tab';
const LOST_TITLE = 'Voxium is now open in another tab';

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/**
 * Record, in every page of `context`, the messages the tabs exchange about
 * the vault (BroadcastChannel `voxium-e2e-vault`): a channel of the page's
 * own receives what the app of the page posts as well as what the other
 * pages do. Read back with `vaultMessages`.
 */
async function recordVaultMessages(context: BrowserContext) {
  await context.addInitScript(() => {
    const seen: unknown[] = [];
    (window as unknown as { __vaultMessages: unknown[] }).__vaultMessages = seen;
    const channel = new BroadcastChannel('voxium-e2e-vault');
    channel.onmessage = (event) => seen.push(event.data);
  });
}

const vaultMessages = (page: Page) =>
  page.evaluate(() => (window as unknown as { __vaultMessages?: Array<Record<string, unknown>> }).__vaultMessages ?? []);

/** The Web Locks of the vaults in the origin, as one page sees them. */
const vaultLocks = (page: Page) =>
  page.evaluate(async () => {
    const state = await navigator.locks.query();
    const ofVault = (lock: { name?: string }) => (lock.name ?? '').startsWith('voxium-e2e-vault:');
    return { held: (state.held ?? []).filter(ofVault).length, pending: (state.pending ?? []).filter(ofVault).length };
  });

/** Make `page` read as a tab in the background from its first script on (see the top of this file). */
async function asBackgroundTab(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get: () => 'hidden' });
    Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: () => true });
  });
}

/** The heading of the screen a tab shows instead of the app. */
const screenTitle = (page: Page, title: string) => page.getByRole('heading', { name: title, exact: true });

async function waitDevice(request: APIRequestContext, viewerToken: string, userId: string) {
  await expect
    .poll(async () => {
      const res = await request.get(`${API_URL}/e2e/devices/${userId}`, { headers: bearer(viewerToken) });
      if (!res.ok()) return 0;
      const body = (await res.json()) as { data?: { devices?: unknown[] } };
      return body.data?.devices?.length ?? 0;
    }, { timeout: 30_000, message: `the E2E device of ${userId} was never published` })
    .toBeGreaterThan(0);
}

/** Send from the composer of the open conversation; resolves once the POST answered 201 and the composer cleared. */
async function send(page: Page, text: string) {
  const posted = page.waitForResponse(
    (r) => r.request().method() === 'POST' && /\/dm\/[^/]+\/messages$/.test(r.url()),
    { timeout: 20_000 }
  );
  await page.locator('textarea').first().fill(text);
  await page.locator('textarea').first().press('Enter');
  const res = await posted;
  expect(res.status(), `POST for "${text}": ${await res.text()}`).toBe(201);
  await expect(page.locator('textarea').first()).toHaveValue('', { timeout: 15_000 });
}

/** A message row carrying `text` (never the composer, which can hold the same words). */
const row = (page: Page, text: string) => page.locator('[data-message-id]', { hasText: text });

test.describe('one tab owns the encrypted vault of an account', () => {
  test('a second tab waits, takes the vault over on "Use it here", and sends and reads encrypted messages', async ({ browser, request }) => {
    test.setTimeout(180_000);
    const aliceUser = testUser('tabsa');
    const bobUser = testUser('tabsb');
    const alice = await registerUser(request, aliceUser);
    const bob = await registerUser(request, bobUser);
    await sendFriendRequest(request, alice.accessToken, bobUser.username);
    await acceptFriendRequest(request, bob.accessToken, alice.user.id);
    // the conversation first: device lists are only served between users who share one
    const opened = await request.post(`${API_URL}/dm`, { data: { userId: bob.user.id }, headers: bearer(alice.accessToken) });
    expect(opened.ok()).toBe(true);

    // ── Alice's first tab owns the vault ──
    const aliceCtx = await browser.newContext();
    await recordVaultMessages(aliceCtx);
    const first = await aliceCtx.newPage();
    await injectAuth(first, alice);
    await expect(dmHeading(first)).toBeVisible({ timeout: 20_000 });
    await waitDevice(request, bob.accessToken, alice.user.id);

    // ── A second tab of the same browser: the screen, not the app ──
    const second = await aliceCtx.newPage();
    await second.goto('/');
    await expect(screenTitle(second, BLOCKED_TITLE)).toBeVisible({ timeout: 20_000 });
    await expect(second.getByRole('heading', { name: 'Direct Messages' })).toHaveCount(0);
    // the first tab is untouched by it
    await expect(dmHeading(first)).toBeVisible();

    // ── "Use it here": the first tab gives the vault up, the second opens the app ──
    await second.getByRole('button', { name: 'Use it here', exact: true }).click();
    await expect(screenTitle(first, LOST_TITLE)).toBeVisible({ timeout: 30_000 });
    await expect(first.getByRole('heading', { name: 'Direct Messages' })).toHaveCount(0);
    await expect(dmHeading(second)).toBeVisible({ timeout: 30_000 });
    // ...by the hand-over, not by the queue: the first tab said `released` to
    // the tab that asked, which took the lock with a steal and said `taken`
    // (a lock handed to the queue instead is taken with no notice at all), and
    // that tab holds the lock now (a take-over by the fence alone holds none)
    await expect
      .poll(async () => {
        const seen = await vaultMessages(first);
        const asked = seen.find((m) => m.type === 'release');
        if (!asked) return 'no release asked';
        const released = seen.some((m) => m.type === 'released' && m.to === asked.from);
        const taken = seen.some((m) => m.type === 'taken' && m.from === asked.from);
        return `released: ${released}, taken by the asker: ${taken}`;
      }, { timeout: 15_000, message: 'the hand-over did not go through released, then a steal' })
      .toBe('released: true, taken by the asker: true');
    expect(await vaultLocks(second)).toEqual({ held: 1, pending: 0 });

    // ── Bob, in a browser of his own ──
    const bobCtx = await browser.newContext();
    const bobPage = await bobCtx.newPage();
    await injectAuth(bobPage, bob);
    await expect(dmHeading(bobPage)).toBeVisible({ timeout: 20_000 });
    await waitDevice(request, alice.accessToken, bob.user.id);

    // ── Alice writes from the tab that took over; Bob reads it decrypted ──
    await second.getByText(bobUser.username, { exact: true }).first().click();
    await expect(second.locator('textarea')).toBeVisible({ timeout: 10_000 });
    const fromAlice = `sent after the hand-over ${Date.now()}`;
    await send(second, fromAlice);
    await expect(row(second, fromAlice)).toHaveCount(1, { timeout: 15_000 });

    await bobPage.getByText(aliceUser.username, { exact: true }).first().click();
    await expect(bobPage.locator('textarea')).toBeVisible({ timeout: 10_000 });
    await expect(row(bobPage, fromAlice)).toHaveCount(1, { timeout: 30_000 });
    await expect(bobPage.getByText('Unable to decrypt this message')).toHaveCount(0);

    // ── Bob answers; the tab that took over reads it decrypted ──
    const fromBob = `answered to the tab that took over ${Date.now()}`;
    await send(bobPage, fromBob);
    await expect(row(second, fromBob)).toHaveCount(1, { timeout: 30_000 });
    await expect(second.getByText('Unable to decrypt this message')).toHaveCount(0);

    // the tab that gave the vault up still shows its screen, nothing of the conversation
    await expect(screenTitle(first, LOST_TITLE)).toBeVisible();
    await expect(row(first, fromBob)).toHaveCount(0);

    await bobCtx.close();
    await aliceCtx.close();
  });

  test('a tab waiting on the screen takes the vault over by itself when the owning tab closes', async ({ browser, request }) => {
    test.setTimeout(120_000);
    const carol = await registerUser(request, testUser('tabsc'));

    const context = await browser.newContext();
    const owner = await context.newPage();
    await injectAuth(owner, carol);
    await expect(dmHeading(owner)).toBeVisible({ timeout: 20_000 });

    const waiting = await context.newPage();
    await waiting.goto('/');
    await expect(screenTitle(waiting, BLOCKED_TITLE)).toBeVisible({ timeout: 20_000 });

    // no click: closing the owner hands the lock to the tab waiting for it
    await owner.close();
    await expect(dmHeading(waiting)).toBeVisible({ timeout: 30_000 });
    await expect(screenTitle(waiting, BLOCKED_TITLE)).toHaveCount(0);

    await context.close();
  });

  test('the owning tab reloads while a second tab of the account waits in the background: the reloaded tab comes back with the app', async ({ browser, request }) => {
    test.setTimeout(120_000);
    const dave = await registerUser(request, testUser('tabsd'));

    const context = await browser.newContext();
    const owner = await context.newPage();
    await injectAuth(owner, dave);
    await expect(dmHeading(owner)).toBeVisible({ timeout: 20_000 });

    // a second tab, in the background: it shows the screen and leaves the lock's queue
    const background = await context.newPage();
    await asBackgroundTab(background);
    await background.goto('/');
    await expect(screenTitle(background, BLOCKED_TITLE)).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => vaultLocks(owner), { timeout: 10_000 }).toEqual({ held: 1, pending: 0 });

    // the owning tab reloads: it lets the lock go, and its new page takes it again
    await owner.reload();
    await expect(dmHeading(owner)).toBeVisible({ timeout: 30_000 });
    await expect(screenTitle(owner, BLOCKED_TITLE)).toHaveCount(0);
    await expect(screenTitle(background, BLOCKED_TITLE)).toBeVisible();
    await expect(background.getByRole('heading', { name: 'Direct Messages' })).toHaveCount(0);

    await context.close();
  });
});
