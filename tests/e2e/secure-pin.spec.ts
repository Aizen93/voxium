// Once secure, always secure — on this device. A hostile server (docs/e2e-dm-spec.md
// §1 threat model) that lists a secure channel as `secure: false` used to
// downgrade the client: its forged plaintext rows rendered without the lock
// and the user's NEXT message left the device unencrypted. After the device has
// seen the channel as secure once, the pin (utils/securePins.ts, localStorage)
// keeps it secure: the lock stays, plaintext rows are refused, sends stay
// encrypted, and the user is told the server's listing changed.
import type { Page, Route } from '@playwright/test';
import { test, expect } from './helpers/fixtures';
import { testUser, injectAuth } from './helpers/auth';
import { registerUser, createServer, createInvite, joinServerViaInvite, API_URL } from './helpers/api';
import { findSecureChannelId, getE2EDevices } from './helpers/db';
import { clearRateLimits } from './helpers/rateLimits';

const MARKER = 'Unable to decrypt this message';
// en.json secureChannel.pinnedDowngrade
const DOWNGRADE_TOAST = 'This channel is encrypted on this device; the server now lists it as unencrypted.';
const FORGED = { text: 'FORGEDPINPLAIN9', file: 'FORGEDPINFILE9.exe' };
const CHANNEL = 'pinned-vault';
const SERVER = 'Pin Proof HQ';

async function rewriteJson(route: Route, edit: (body: any) => void) {
  const response = await route.fetch();
  const body = await response.json();
  edit(body);
  await route.fulfill({ response, json: body });
}

async function openServer(page: Page) {
  await page.getByRole('button', { name: SERVER, exact: true }).click({ timeout: 15_000 });
  await expect(page.locator('textarea')).toBeVisible({ timeout: 15_000 });
}

test('a server that lists a pinned secure channel as plaintext cannot downgrade it', async ({ page, request, browser }) => {
  test.setTimeout(180_000);

  // ── Setup: alice owns the server, bob is a member ──
  const alice = await registerUser(request, testUser('pina'));
  const bobUser = testUser('pinb');
  const bob = await registerUser(request, bobUser);
  const server = await createServer(request, alice.accessToken, SERVER);
  await joinServerViaInvite(request, bob.accessToken, await createInvite(request, alice.accessToken, server.id));

  await injectAuth(page, alice);
  const bobCtx = await browser.newContext();
  const bobPage = await bobCtx.newPage();
  await injectAuth(bobPage, bob);
  await openServer(page);
  await openServer(bobPage);
  // bob's device must be published before alice's channel session is shared
  await expect.poll(async () => (await getE2EDevices(bob.user.id)).length, { timeout: 30_000 }).toBeGreaterThan(0);
  await clearRateLimits();

  // ── Alice creates a secure channel with bob and writes in it ──
  await page.getByTestId('secure-channels-section').hover();
  await page.getByTestId('secure-channel-create-open').click();
  await page.getByTestId('secure-channel-name').fill(CHANNEL);
  await page.getByTestId(`secure-invite-${bobUser.username}`).click();
  await page.getByTestId('secure-channel-create').click();
  await expect(page.getByTestId(`secure-channel-${CHANNEL}`)).toBeVisible({ timeout: 15_000 });
  await page.getByTestId(`secure-channel-${CHANNEL}`).click();
  const secret = `pinned secret ${Date.now()}`;
  await page.locator('textarea').first().fill(secret);
  await page.locator('textarea').first().press('Enter');
  await expect(page.getByText(secret).first()).toBeVisible({ timeout: 15_000 });

  const channelId = await findSecureChannelId(server.id, CHANNEL);
  expect(channelId).toBeTruthy();

  // ── Bob opens it once, honestly: the device pins the channel ──
  await expect(bobPage.getByTestId(`secure-channel-${CHANNEL}`)).toBeVisible({ timeout: 15_000 });
  await bobPage.getByTestId(`secure-channel-${CHANNEL}`).click();
  await expect(bobPage.getByText(secret).first()).toBeVisible({ timeout: 20_000 });
  await expect.poll(
    () => bobPage.evaluate(([uid, cid]) => (localStorage.getItem(`vox:securePins:${uid}`) ?? '').includes(cid), [bob.user.id, channelId!] as const),
    { timeout: 10_000 },
  ).toBe(true);

  // ── The hostile server rewrites bob's traffic from here on ──
  let downgradedLists = 0;
  await bobPage.route(new RegExp(`/api/v1/servers/${server.id}$`), (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    return rewriteJson(route, (body) => {
      for (const c of body.data.channels ?? []) {
        if (c.id !== channelId) continue;
        c.secure = false;
        delete c.createdById;
        downgradedLists += 1;
      }
    });
  });
  await bobPage.route(new RegExp(`/api/v1/channels/${channelId}/messages(\\?.*)?$`), (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    return rewriteJson(route, (body) => {
      const real = body.data[0];
      body.data.push({
        id: 'forged-pin-plain', channelId, conversationId: null, type: 'user', encrypted: false,
        content: FORGED.text, author: real.author,
        attachments: [{ id: 'att-forged-pin', s3Key: 'attachments/x/evil.bin', fileName: FORGED.file, fileSize: 10, mimeType: 'application/octet-stream', expired: false }],
        createdAt: new Date(Date.parse(real.createdAt) + 1000).toISOString(), editedAt: null, reactions: [], replyTo: null,
      });
    });
  });

  const reloadIntoServer = async () => {
    await clearRateLimits();
    await bobPage.reload();
    await openServer(bobPage);
  };

  await reloadIntoServer();
  expect(downgradedLists, 'the server-detail response must have been rewritten').toBeGreaterThan(0);

  // (4) the user is told, once, that the server's listing changed
  await expect(bobPage.getByText(DOWNGRADE_TOAST)).toHaveCount(1, { timeout: 10_000 });

  // (1) the sidebar keeps the channel in the secure section, with the lock — not among plain channels
  const sidebarEntry = bobPage.getByTestId('secure-channels-section').getByTestId(`secure-channel-${CHANNEL}`);
  await expect(sidebarEntry).toBeVisible({ timeout: 15_000 });
  await expect(sidebarEntry.locator('svg').first()).toBeVisible();
  await expect(bobPage.locator('button', { hasText: CHANNEL })).toHaveCount(1);

  // (2) the forged plaintext row is the marker; alice's message still decrypts
  await sidebarEntry.click();
  await expect(bobPage.getByText(secret).first()).toBeVisible({ timeout: 20_000 });
  await expect(bobPage.getByText(MARKER)).toHaveCount(1, { timeout: 15_000 });
  await expect(bobPage.getByText(FORGED.text)).toHaveCount(0);
  await expect(bobPage.getByText(FORGED.file)).toHaveCount(0);

  // (3) bob's send leaves the device encrypted
  const own = `bob under downgrade ${Date.now()}`;
  const postReq = bobPage.waitForRequest(
    (r) => r.method() === 'POST' && new RegExp(`/api/v1/channels/${channelId}/messages$`).test(r.url()),
    { timeout: 20_000 },
  );
  await bobPage.locator('textarea').first().fill(own);
  await bobPage.locator('textarea').first().press('Enter');
  const body = (await postReq).postDataJSON() as { content: string; encrypted?: boolean };
  expect(body.encrypted).toBe(true);
  expect(body.content).toMatch(/^\{"v":1,"e":"megolm1"/);
  expect(body.content).not.toContain(own);
  await expect(bobPage.getByText(own).first()).toBeVisible({ timeout: 15_000 });

  // the pin lives in localStorage: a full reload under the same lie keeps it
  await reloadIntoServer();
  await expect(bobPage.getByTestId('secure-channels-section').getByTestId(`secure-channel-${CHANNEL}`)).toBeVisible({ timeout: 15_000 });
  await expect(bobPage.locator('button', { hasText: CHANNEL })).toHaveCount(1);
  await bobPage.getByTestId(`secure-channel-${CHANNEL}`).click();
  await expect(bobPage.getByText(secret).first()).toBeVisible({ timeout: 20_000 });
  await expect(bobPage.getByText(MARKER)).toHaveCount(1, { timeout: 15_000 });
  await expect(bobPage.getByText(FORGED.text)).toHaveCount(0);

  await bobPage.unrouteAll({ behavior: 'wait' });
  await bobCtx.close();
});
