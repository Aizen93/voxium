import type { Page, APIRequestContext, Browser } from '@playwright/test';
import { test, expect } from './helpers/fixtures';
import { testUser, injectAuth } from './helpers/auth';
import {
  registerUser, createServer, createInvite, setServerDiscovery, kickMember, unbanMember, tryJoinServerViaInvite,
} from './helpers/api';
import { clearRateLimits } from './helpers/rateLimits';

// Live two/three-client test of server discovery (docs/local/server-discovery-plan.html,
// "Playwright server-discovery.spec.ts"):
//   (a) the owner fills the card and opens the server → a newcomer finds it in
//       Explore by search and by tag, joins, and messages flow live (the room
//       invariant) → the owner removes them (a ban) → Join and a fresh invite
//       are refused → unban → they can join again.
//   (b) approval mode → a request with a message → the owner sees it under
//       Members → Join requests and approves → the strip gains the server with
//       a toast; a second requester is declined → toast + the cooldown refusal.
// Member counts (live) are asserted; activity figures (daily) never are.

/** The app shell is up (the spaces strip rendered). A cold Vite dev server
 *  compiles the whole module graph on the first authenticated visit, which
 *  can take well over the default expect timeout — only the first wait of
 *  a run ever pays it. */
async function waitForApp(page: Page) {
  await expect(page.getByTestId('spaces-strip')).toBeVisible({ timeout: 90_000 });
}

async function openServer(page: Page, serverName: string) {
  await waitForApp(page);
  await page.getByRole('button', { name: serverName, exact: true }).click({ timeout: 15_000 });
  await expect(page.locator('textarea')).toBeVisible({ timeout: 15_000 });
}

async function openExplore(page: Page) {
  await page.getByTestId('discovery-open').click();
  await expect(page.getByTestId('discovery-modal')).toBeVisible({ timeout: 15_000 });
}

async function closeExplore(page: Page) {
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('discovery-modal')).toHaveCount(0);
}

/** Search Explore and return the card locator for that server. */
async function findInExplore(page: Page, serverId: string, query: string) {
  await page.getByTestId('discovery-search').fill(query);
  const card = page.locator(`[data-testid="discovery-card"][data-server-id="${serverId}"]`);
  await expect(card.first()).toBeVisible({ timeout: 15_000 });
  return card.first();
}

const toasts = (page: Page) => page.getByTestId('toast-container');

async function newUserPage(browser: Browser, request: APIRequestContext, prefix: string) {
  const user = testUser(prefix);
  const data = await registerUser(request, user);
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('pageerror', (err) => console.log(`[pageerror ${prefix}]`, err.message));
  await injectAuth(page, data);
  await waitForApp(page);
  return { user, data, page, context };
}

test.describe('Server discovery — Explore and the request flow', () => {
  test.beforeEach(({ page }) => {
    page.on('pageerror', (err) => console.log('[pageerror owner]', err.message));
  });

  test('open mode: card, search, tag, join, live messages, remove-and-ban, invite refused, unban, rejoin', async ({ page, request, browser }) => {
    test.setTimeout(240_000);

    const stamp = Date.now().toString(36);
    const serverName = `Raid Night ${stamp}`;
    const owner = testUser('disco');
    const dataOwner = await registerUser(request, owner);
    const server = await createServer(request, dataOwner.accessToken, serverName);

    // ── Owner fills the card from Server settings → Discovery and opens the server ──
    await injectAuth(page, dataOwner);
    await openServer(page, serverName);
    await page.getByLabel('Server Settings').click();
    await page.getByTestId('tab-discovery').click();
    await page.getByTestId('discovery-description').fill('EU-evening raid group, no drama.');
    await page.getByTestId('discovery-tag-gaming').click();
    await page.getByTestId('discovery-join-open').check();
    // the preview IS the card newcomers will see
    await expect(page.getByTestId('discovery-card-description')).toHaveText('EU-evening raid group, no drama.');
    await page.getByTestId('discovery-save').click();
    await expect(toasts(page)).toContainText('Discovery settings saved', { timeout: 15_000 });
    await page.getByRole('dialog').getByLabel('Close').first().click();

    // ── Newcomer B finds it in Explore, by search and by tag, and joins ──
    const b = await newUserPage(browser, request, 'discob');
    await clearRateLimits();
    await openExplore(b.page);
    let card = await findInExplore(b.page, server.id, serverName);
    await expect(card.getByTestId('discovery-card-description')).toHaveText('EU-evening raid group, no drama.');
    await expect(card.getByTestId('discovery-card-members')).toContainText('1 member');
    await expect(card.getByTestId('discovery-join')).toHaveText('Join');

    // tag filter: a wrong tag hides it, the right one keeps it
    await b.page.getByTestId('discovery-tag-music').click();
    await expect(b.page.locator(`[data-testid="discovery-card"][data-server-id="${server.id}"]`)).toHaveCount(0, { timeout: 15_000 });
    await b.page.getByTestId('discovery-tag-gaming').click();
    card = b.page.locator(`[data-testid="discovery-card"][data-server-id="${server.id}"]`).first();
    await expect(card).toBeVisible({ timeout: 15_000 });

    await card.getByTestId('discovery-join').click();
    await expect(toasts(b.page)).toContainText(`Welcome to ${serverName}`, { timeout: 15_000 });
    await expect(b.page.getByTestId('discovery-modal')).toHaveCount(0);
    // the strip has it and the server is open
    await expect(b.page.getByRole('button', { name: serverName, exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(b.page.locator('textarea')).toBeVisible({ timeout: 15_000 });

    // ── The room invariant: B's message reaches the owner live ──
    const hello = `joined from Explore ${stamp}`;
    await b.page.locator('textarea').first().fill(hello);
    await b.page.locator('textarea').first().press('Enter');
    await expect(page.getByText(hello).first()).toBeVisible({ timeout: 20_000 });

    // The member count is live on the owner's side (Settings → Discovery reads
    // the server row); the directory page itself is cached for a minute, so
    // the card may still say 1 for other viewers — never asserted here.
    await page.getByLabel('Server Settings').click();
    await page.getByTestId('tab-discovery').click();
    await expect(page.getByTestId('discovery-stats')).toContainText('Members: 2', { timeout: 15_000 });
    await page.getByRole('dialog').getByLabel('Close').first().click();
    // B's card reads Open (the viewer's flags are never cached)
    await openExplore(b.page);
    card = await findInExplore(b.page, server.id, serverName);
    await expect(card.getByTestId('discovery-open')).toBeVisible();
    await closeExplore(b.page);

    // ── Owner removes B (every removal is a ban) ──
    await kickMember(request, dataOwner.accessToken, server.id, b.data.user.id, 'raid-night no-show');
    await expect(toasts(b.page)).toContainText('kicked', { timeout: 15_000 });
    await expect(b.page.getByRole('button', { name: serverName, exact: true })).toHaveCount(0, { timeout: 15_000 });

    // Join is refused, and so is a fresh invite
    await openExplore(b.page);
    card = await findInExplore(b.page, server.id, serverName);
    await expect(card.getByTestId('discovery-join')).toHaveText('Join');
    await card.getByTestId('discovery-join').click();
    await expect(toasts(b.page)).toContainText('banned', { timeout: 15_000 });
    const invite = await createInvite(request, dataOwner.accessToken, server.id);
    const refused = await tryJoinServerViaInvite(request, b.data.accessToken, invite);
    expect(refused.status).toBe(403);
    expect(refused.error).toContain('banned');

    // ── Unban: B can join again ──
    await unbanMember(request, dataOwner.accessToken, server.id, b.data.user.id);
    await card.getByTestId('discovery-join').click();
    await expect(toasts(b.page)).toContainText(`Welcome to ${serverName}`, { timeout: 15_000 });
    await expect(b.page.getByRole('button', { name: serverName, exact: true })).toBeVisible({ timeout: 15_000 });

    await b.context.close();
  });

  test('approval mode: request with a message, approve from Members, decline + cooldown', async ({ page, request, browser }) => {
    test.setTimeout(240_000);

    const stamp = Date.now().toString(36);
    const serverName = `Lingua Lounge ${stamp}`;
    const owner = testUser('discm');
    const dataOwner = await registerUser(request, owner);
    const server = await createServer(request, dataOwner.accessToken, serverName);
    // approval is the default join mode; the description comes from the owner API
    await setServerDiscovery(request, dataOwner.accessToken, server.id, { description: 'Daily language exchange in voice.', tags: ['languages'] });

    await injectAuth(page, dataOwner);
    await openServer(page, serverName);

    // ── B requests with a message ──
    const b = await newUserPage(browser, request, 'reqb');
    await clearRateLimits();
    await openExplore(b.page);
    let cardB = await findInExplore(b.page, server.id, serverName);
    await expect(cardB.getByTestId('discovery-join')).toHaveText('Request to join');
    await cardB.getByTestId('discovery-join').click();
    await expect(b.page.getByTestId('join-request-dialog')).toBeVisible();
    const message = `Learning French, evenings ${stamp}`;
    await b.page.getByTestId('join-request-message').fill(message);
    await b.page.getByTestId('join-request-send').click();
    await expect(toasts(b.page)).toContainText(`Request sent to ${serverName}`, { timeout: 15_000 });
    cardB = b.page.locator(`[data-testid="discovery-card"][data-server-id="${server.id}"]`).first();
    await expect(cardB.getByTestId('discovery-requested')).toBeVisible();
    await expect(cardB.getByTestId('discovery-cancel-request')).toBeVisible();

    // ── The owner sees it under Members → Join requests, with the message, and approves ──
    await expect(toasts(page)).toContainText(`asked to join ${serverName}`, { timeout: 15_000 });
    await page.getByLabel('Server Settings').click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: /^Members/ }).click();
    const rowB = page.getByTestId('join-request-row').filter({ hasText: b.user.username });
    await expect(rowB).toBeVisible({ timeout: 15_000 });
    await expect(rowB.getByTestId('join-request-message')).toHaveText(message);
    await rowB.getByTestId('join-request-approve').click();
    await expect(toasts(page)).toContainText('is now a member', { timeout: 15_000 });
    await expect(rowB).toHaveCount(0);

    // B's strip gains the server with a toast; the card now reads Open
    await expect(toasts(b.page)).toContainText('approved your request', { timeout: 15_000 });
    await expect(cardB.getByTestId('discovery-open')).toBeVisible({ timeout: 15_000 });
    await closeExplore(b.page);
    await expect(b.page.getByRole('button', { name: serverName, exact: true })).toBeVisible({ timeout: 15_000 });

    // ── C requests and is declined: toast, then the cooldown refuses a retry ──
    const c = await newUserPage(browser, request, 'reqc');
    await clearRateLimits();
    await openExplore(c.page);
    const cardC = await findInExplore(c.page, server.id, serverName);
    await cardC.getByTestId('discovery-join').click();
    await c.page.getByTestId('join-request-send').click();
    await expect(toasts(c.page)).toContainText(`Request sent to ${serverName}`, { timeout: 15_000 });

    const rowC = page.getByTestId('join-request-row').filter({ hasText: c.user.username });
    await expect(rowC).toBeVisible({ timeout: 15_000 });
    await rowC.getByTestId('join-request-decline').click();
    await expect(rowC).toHaveCount(0);

    await expect(toasts(c.page)).toContainText('declined your join request', { timeout: 15_000 });
    const cardCAfter = c.page.locator(`[data-testid="discovery-card"][data-server-id="${server.id}"]`).first();
    await expect(cardCAfter.getByTestId('discovery-join')).toHaveText('Request to join', { timeout: 15_000 });
    await cardCAfter.getByTestId('discovery-join').click();
    await c.page.getByTestId('join-request-send').click();
    await expect(toasts(c.page)).toContainText('declined recently', { timeout: 15_000 });

    await b.context.close();
    await c.context.close();
  });
});
