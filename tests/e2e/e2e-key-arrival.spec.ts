// A row whose group session has not reached this device renders "Unable to
// decrypt this message". Once the session arrives, the row on screen opens in
// place, without leaving the conversation and without fetching it again
// (docs/e2e-dm-spec.md §9.1).
//
// The session is held back by refusing Bob's key-share claims while Alice's
// message arrives (a refusal is an answer: nothing is claimed again on a
// timer). Carol's first message to Bob then misses on a session of its own,
// and the claim it starts brings Alice's share with Carol's.
import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from './helpers/fixtures';
import { testUser, injectAuth } from './helpers/auth';
import { registerUser, sendFriendRequest, acceptFriendRequest, API_URL } from './helpers/api';
import { dmHeading } from './helpers/selectors';

const MARKER = 'Unable to decrypt this message';

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

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

test('a row that could not be decrypted opens in place when its key arrives', async ({ page, request, browser }) => {
  test.setTimeout(180_000);
  const alice = await registerUser(request, testUser('kara'));
  const bobUser = testUser('karb');
  const bob = await registerUser(request, bobUser);
  const carol = await registerUser(request, testUser('karc'));
  await sendFriendRequest(request, alice.accessToken, bobUser.username);
  await acceptFriendRequest(request, bob.accessToken, alice.user.id);
  await sendFriendRequest(request, carol.accessToken, bobUser.username);
  await acceptFriendRequest(request, bob.accessToken, carol.user.id);
  // both conversations first: device lists are only served between users who share one
  const withAlice = await request.post(`${API_URL}/dm`, { data: { userId: bob.user.id }, headers: bearer(alice.accessToken) });
  expect(withAlice.ok()).toBe(true);
  const aliceConversationId: string = (await withAlice.json()).data.id;
  const withCarol = await request.post(`${API_URL}/dm`, { data: { userId: bob.user.id }, headers: bearer(carol.accessToken) });
  expect(withCarol.ok()).toBe(true);

  // ── Bob's browser, on the conversation with Alice ──
  const bobCtx = await browser.newContext();
  const bobPage = await bobCtx.newPage();
  await injectAuth(bobPage, bob);
  await expect(dmHeading(bobPage)).toBeVisible({ timeout: 20_000 });
  await waitDevice(request, alice.accessToken, bob.user.id);
  await bobPage.getByText(alice.user.username, { exact: true }).first().click();
  await expect(bobPage.locator('textarea')).toBeVisible({ timeout: 10_000 });

  // every fetch of that conversation's messages from here on
  const refetches: string[] = [];
  bobPage.on('request', (req) => {
    if (req.method() === 'GET' && req.url().includes(`/dm/${aliceConversationId}/messages`)) refetches.push(req.url());
  });

  // Bob's key-share claims are refused until Alice's message is on his screen.
  // An answer the page can read (the API is another origin, so it carries the
  // CORS headers the server would send): a refusal, never a lost answer, which
  // would claim again on a timer. Nothing reaches the server, so nothing is leased.
  let refuseClaims = true;
  let refused = 0;
  await bobPage.route(
    (url) => url.pathname.endsWith('/api/v1/e2e/keyshares'),
    async (route) => {
      if (refuseClaims && route.request().method() === 'GET') {
        refused += 1;
        const origin = route.request().headers()['origin'] ?? new URL(bobPage.url()).origin;
        return route.fulfill({
          status: 503,
          headers: {
            'access-control-allow-origin': origin,
            'access-control-allow-credentials': 'true',
            vary: 'Origin',
          },
          json: { success: false, error: 'Service unavailable' },
        });
      }
      return route.continue();
    }
  );

  // ── Alice writes ──
  await injectAuth(page, alice);
  await expect(dmHeading(page)).toBeVisible({ timeout: 20_000 });
  await waitDevice(request, bob.accessToken, alice.user.id);
  await page.getByText(bobUser.username, { exact: true }).first().click();
  await expect(page.locator('textarea')).toBeVisible({ timeout: 10_000 });
  const secret = `opened when its key arrived ${Date.now()}`;
  await send(page, secret);
  await expect(row(page, secret)).toHaveCount(1, { timeout: 15_000 });

  // Bob's client got the message but not its key: the marker, not the text
  await expect(bobPage.getByText(MARKER)).toHaveCount(1, { timeout: 20_000 });
  await expect(row(bobPage, secret)).toHaveCount(0);
  expect(refused).toBeGreaterThan(0);
  refuseClaims = false;
  const fetchesBefore = refetches.length;

  // ── Carol's first message to Bob: its claim brings Alice's share too ──
  const carolCtx = await browser.newContext();
  const carolPage = await carolCtx.newPage();
  await injectAuth(carolPage, carol);
  await expect(dmHeading(carolPage)).toBeVisible({ timeout: 20_000 });
  await waitDevice(request, bob.accessToken, carol.user.id);
  await carolPage.getByText(bobUser.username, { exact: true }).first().click();
  await expect(carolPage.locator('textarea')).toBeVisible({ timeout: 10_000 });
  await send(carolPage, `hello from carol ${Date.now()}`);

  // ── The row on Bob's screen opens where it is ──
  await expect(row(bobPage, secret)).toHaveCount(1, { timeout: 30_000 });
  await expect(bobPage.getByText(MARKER)).toHaveCount(0);
  // still the conversation with Alice, never fetched again
  await expect(bobPage.locator('textarea')).toBeVisible();
  expect(refetches.length).toBe(fetchesBefore);

  await carolCtx.close();
  await bobCtx.close();
});
