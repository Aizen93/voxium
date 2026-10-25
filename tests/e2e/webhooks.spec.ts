import { readFileSync } from 'fs';
import { resolve } from 'path';
import { createHmac, randomBytes } from 'crypto';
import type { APIRequestContext, APIResponse, BrowserContext, Locator, Page } from '@playwright/test';
import { test, expect } from './helpers/fixtures';
import { testUser, injectAuth } from './helpers/auth';
import { API_URL, registerUser, createServer, createChannel, deleteServer } from './helpers/api';
import { deleteSeededUsers, deleteServersNamed } from './helpers/db';

// Live test of incoming webhooks (docs/local/webhooks-plan.html, step 4):
// one owner, one server, one text channel kept OPEN in one page for the whole
// run, so every message (and every purge) is seen arriving live:
//   1. a generic webhook is created from Server settings → Integrations; the
//      copy-once panel is the only place its URL is shown;
//   2. a Discord-shaped POST lands in the open channel under the webhook's
//      name, marked APP, embed flattened, no profile hover — live and after
//      a reload (the REST reader shapes the author the same way);
//   3. a wrong token and an unknown id answer the identical 404;
//   4. a GitHub webhook comes with a signing secret; a signed push fixture is
//      formatted, an unsigned or mis-signed replay is a 401;
//   5. rotation: a new URL, the old one is dead at once;
//   6. delete with purge: the webhook's messages leave the open channel
//      without a reload (message:bulk_deleted), the other webhook's stay.
// The webhooks feature flag is never toggled here (unit tests cover it).

const stamp = Date.now().toString(36);
// Every account this spec registers starts with it: the afterAll sweep
const USER_PREFIX = `whk${stamp}`;
const SERVER_NAME = `Hook Lab ${stamp}`;
const CHANNEL = 'ci-alerts';
const GENERIC_NAME = `Nightly build ${stamp}`;
const GITHUB_NAME = `Rocket repo ${stamp}`;
const NOT_FOUND = { success: false, error: 'Webhook not found' };
const PUSH_FIXTURE = resolve(__dirname, '../../apps/server/src/__tests__/fixtures/github/push-branch.json');

interface RevealedWebhook {
  id: string;
  token: string;
  url: string;
  secret?: string;
}

/** The app shell is up. A cold Vite dev server compiles the whole module
 *  graph on the first authenticated visit: only the first wait pays it. */
async function waitForApp(page: Page) {
  await expect(page.getByTestId('spaces-strip')).toBeVisible({ timeout: 90_000 });
}

async function openChannel(page: Page) {
  await waitForApp(page);
  await page.getByRole('button', { name: SERVER_NAME, exact: true }).click({ timeout: 15_000 });
  await page.getByText(CHANNEL, { exact: true }).first().click({ timeout: 15_000 });
  await expect(page.getByPlaceholder(`Message #${CHANNEL}`)).toBeVisible({ timeout: 15_000 });
}

/** Server settings → Integrations, once the list has loaded. */
async function openIntegrations(page: Page): Promise<Locator> {
  await page.getByLabel('Space Settings').click();
  await page.getByTestId('tab-integrations').click();
  const tab = page.getByTestId('integrations-tab');
  await expect(tab.getByTestId('integrations-count')).toBeVisible({ timeout: 15_000 });
  return tab;
}

/** Only call with no webhook dialog open: those are dialogs too. */
async function closeSettings(page: Page) {
  await page.getByRole('dialog').getByLabel('Close', { exact: true }).first().click();
  await expect(page.getByTestId('integrations-tab')).toHaveCount(0);
}

/**
 * Read the URL (and a GitHub secret) off the copy-once panel's DOM — never
 * from the clipboard — and split the URL into the id and the token.
 */
async function readReveal(page: Page): Promise<RevealedWebhook> {
  const reveal = page.getByTestId('webhook-reveal');
  await expect(reveal).toBeVisible({ timeout: 15_000 });
  const url = ((await reveal.getByTestId('webhook-reveal-url').textContent()) ?? '').trim();
  expect(url.startsWith(`${API_URL}/webhooks/`), `execute URL: ${url}`).toBe(true);
  const [id, token, ...rest] = url.slice(`${API_URL}/webhooks/`.length).split('/');
  expect(id, 'webhook id in the URL').toBeTruthy();
  expect(token, 'token in the URL').toBeTruthy();
  expect(rest, 'nothing after the token').toEqual([]);
  const secretBlock = reveal.getByTestId('webhook-reveal-secret');
  const secret = (await secretBlock.count()) > 0 ? ((await secretBlock.textContent()) ?? '').trim() : undefined;
  return { id, token, url, ...(secret ? { secret } : {}) };
}

async function createWebhookViaUI(page: Page, channelId: string, name: string, type: 'generic' | 'github') {
  await page.getByTestId('webhook-new').click();
  const dialog = page.getByTestId('webhook-create-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByTestId('webhook-create-name').fill(name);
  await dialog.getByTestId('webhook-create-channel').selectOption(channelId);
  await dialog.getByTestId(`webhook-type-${type}`).check();
  await dialog.getByTestId('webhook-create-submit').click();
  await expect(dialog).toHaveCount(0, { timeout: 15_000 });
  return readReveal(page);
}

async function closeReveal(page: Page) {
  await page.getByTestId('webhook-reveal-done').click();
  await expect(page.getByTestId('webhook-reveal')).toHaveCount(0);
}

/** The row of the open channel that carries this text. */
function messageRow(page: Page, text: string): Locator {
  return page.locator('[data-message-id]', { hasText: text });
}

async function expectNotFound(res: APIResponse) {
  expect(res.status()).toBe(404);
  expect(await res.json()).toEqual(NOT_FOUND);
}

/**
 * A webhook author is plain text, not a profile hover target: the name sits
 * directly beside its APP tag. A human author's name is wrapped in
 * UserHoverTarget's element, so its parent never holds the header's badges.
 */
async function expectPlainWebhookAuthor(row: Locator, name: string) {
  const author = row.getByTestId('webhook-author-name');
  await expect(author).toHaveText(name);
  await expect(row.getByTestId('app-tag')).toHaveText('APP');
  const besideTag = await author.evaluate((el) => el.parentElement?.querySelector(':scope > [data-testid="app-tag"]') != null);
  expect(besideTag, 'the webhook name is not wrapped in a hover target').toBe(true);
}

/** Sign the exact bytes as GitHub does: X-Hub-Signature-256: sha256=<hex HMAC>. */
function githubSignature(body: Buffer, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

function pushDelivery(request: APIRequestContext, url: string, body: Buffer, signature?: string) {
  return request.post(url, {
    // a Buffer goes out byte for byte: the signature covers exactly these bytes
    data: body,
    headers: {
      'Content-Type': 'application/json',
      'X-GitHub-Event': 'push',
      'X-GitHub-Delivery': `e2e-${stamp}`,
      ...(signature ? { 'X-Hub-Signature-256': signature } : {}),
    },
  });
}

test.describe('Incoming webhooks', () => {
  test.describe.configure({ mode: 'serial' });

  // One page for the whole describe: the channel stays open across the steps
  let context: BrowserContext;
  let page: Page;
  let owner: Awaited<ReturnType<typeof registerUser>>;
  let serverId = '';
  let channelId = '';
  let maxWebhooks = 0;
  let generic: RevealedWebhook;
  let github: RevealedWebhook;
  const genericContent = `Nightly deploy ${stamp}`;
  const rotatedContent = `Posted after the rotation ${stamp}`;

  test.beforeAll(async ({ browser, request }) => {
    test.setTimeout(180_000);
    owner = await registerUser(request, testUser(USER_PREFIX));
    const server = await createServer(request, owner.accessToken, SERVER_NAME);
    serverId = server.id;
    channelId = (await createChannel(request, owner.accessToken, serverId, CHANNEL, 'text')).id;

    // The cap the tab counts against (GlobalConfig may override the default)
    const limits = await request.get(`${API_URL}/servers/${serverId}/limits`, {
      headers: { Authorization: `Bearer ${owner.accessToken}` },
    });
    expect(limits.ok()).toBe(true);
    maxWebhooks = (await limits.json()).data.maxWebhooksPerServer;
    expect(maxWebhooks, 'room for the two webhooks this spec creates').toBeGreaterThanOrEqual(2);

    context = await browser.newContext();
    page = await context.newPage();
    page.on('pageerror', (err) => console.log('[pageerror owner]', err.message));
    await injectAuth(page, owner);
    await openChannel(page);
  });

  test.afterEach(async ({}, testInfo) => {
    // The shared page is not the `page` fixture: no automatic failure screenshot
    if (page && testInfo.status !== testInfo.expectedStatus) {
      await page.screenshot({ path: testInfo.outputPath('failure.png'), fullPage: true })
        .catch((err) => console.warn('[e2e] failure screenshot failed:', err instanceof Error ? err.message : err));
    }
  });

  test.afterAll(async ({ request }) => {
    await context?.close().catch((err) => console.warn('[e2e] context close failed:', err instanceof Error ? err.message : err));
    // The server first (Server.owner is Restrict); its webhooks, channels and messages cascade.
    // Through the API first; should that fail (an access token that expired during a long
    // run), straight from the database, or the user sweep below fails too and leaves all behind
    let serverDeleted = false;
    if (serverId && owner) {
      serverDeleted = await deleteServer(request, owner.accessToken, serverId).then(
        () => true,
        (err) => {
          console.warn('[e2e] server cleanup through the API failed, deleting from the database:', err instanceof Error ? err.message : err);
          return false;
        },
      );
    }
    if (!serverDeleted) {
      await deleteServersNamed(SERVER_NAME, USER_PREFIX)
        .catch((err) => console.warn('[e2e] server cleanup failed:', err instanceof Error ? err.message : err));
    }
    await deleteSeededUsers(USER_PREFIX).catch((err) => console.warn('[e2e] user cleanup failed:', err));
  });

  test('create a generic webhook from Settings → Integrations: the URL is shown once, the row lists it', async () => {
    test.setTimeout(60_000);
    const tab = await openIntegrations(page);
    await expect(tab.getByTestId('integrations-empty')).toBeVisible();
    await expect(tab.getByTestId('integrations-count')).toContainText(`0 of ${maxWebhooks}`);

    generic = await createWebhookViaUI(page, channelId, GENERIC_NAME, 'generic');
    const reveal = page.getByTestId('webhook-reveal');
    await expect(reveal).toContainText(`${GENERIC_NAME} is ready`);
    await expect(reveal.getByTestId('webhook-reveal-warning')).toContainText('shown once');
    // generic: a curl line to try it, no secret, no GitHub steps
    await expect(reveal.getByTestId('webhook-reveal-curl')).toContainText(generic.url);
    await expect(reveal.getByTestId('webhook-reveal-secret')).toHaveCount(0);
    await expect(reveal.getByTestId('github-setup')).toHaveCount(0);
    // the deliberate close only: Escape does not discard the only copy
    await page.keyboard.press('Escape');
    await expect(reveal).toBeVisible();
    await closeReveal(page);

    const row = tab.getByTestId(`webhook-row-${generic.id}`);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row.getByTestId('webhook-name')).toHaveText(GENERIC_NAME);
    await expect(row.getByTestId('webhook-channel')).toHaveText(CHANNEL);
    await expect(row.getByTestId('webhook-type')).toHaveText('Generic');
    await expect(row.getByTestId('webhook-last-used')).toHaveText('never used');
    await expect(row.getByTestId('webhook-creator')).toHaveText(`created by ${owner.user.username}`);
    await expect(tab.getByTestId('integrations-count')).toContainText(`1 of ${maxWebhooks}`);
    // once closed, the token is nowhere on the page
    await expect(page.locator('body')).not.toContainText(generic.token);
    await closeSettings(page);
  });

  test('a Discord-shaped POST lands in the open channel under the webhook name, APP-tagged, embed flattened', async ({ request }) => {
    test.setTimeout(90_000);
    const res = await request.post(generic.url, {
      data: {
        content: genericContent,
        embeds: [{
          title: 'Deploy finished',
          description: 'All green on main',
          fields: [{ name: 'Duration', value: '3m' }],
          footer: { text: 'ci.example' },
          // dropped by the renderer: nothing may make a reader fetch a third-party URL
          thumbnail: { url: 'https://images.example/thumb.png' },
        }],
      },
    });
    expect(res.status()).toBe(204);

    // Live (message:new into the open channel)
    const row = messageRow(page, genericContent);
    await expect(row).toHaveCount(1, { timeout: 15_000 });
    await expectPlainWebhookAuthor(row, GENERIC_NAME);
    const quote = row.locator('blockquote');
    await expect(quote).toHaveCount(1);
    await expect(quote.locator('strong', { hasText: 'Deploy finished' })).toBeVisible();
    await expect(quote).toContainText('All green on main');
    await expect(quote).toContainText('Duration: 3m');
    await expect(quote).toContainText('ci.example');
    await expect(row.locator('img[src*="images.example"]')).toHaveCount(0);

    // After a reload (the REST reader): the same webhook author
    await page.reload();
    await openChannel(page);
    const reloaded = messageRow(page, genericContent);
    await expect(reloaded).toHaveCount(1, { timeout: 15_000 });
    await expectPlainWebhookAuthor(reloaded, GENERIC_NAME);
    await expect(reloaded.locator('blockquote')).toContainText('Duration: 3m');
  });

  test('a wrong token and an unknown id answer the identical 404', async ({ request }) => {
    // same length, last character changed: a token that is wrong, not malformed
    const last = generic.token.slice(-1);
    const wrongToken = `${generic.token.slice(0, -1)}${last === 'a' ? 'b' : 'a'}`;
    const wrong = await request.post(`${API_URL}/webhooks/${generic.id}/${wrongToken}`, { data: { content: 'wrong token' } });
    await expectNotFound(wrong);

    const unknownId = `c${randomBytes(12).toString('hex')}`;
    const unknown = await request.post(`${API_URL}/webhooks/${unknownId}/${generic.token}`, { data: { content: 'unknown id' } });
    await expectNotFound(unknown);
    expect(await unknown.text()).toBe(await wrong.text());

    await expect(messageRow(page, 'wrong token')).toHaveCount(0);
    await expect(messageRow(page, 'unknown id')).toHaveCount(0);
  });

  test('a GitHub webhook: URL + secret shown once, a signed push is formatted, an unsigned replay is a 401', async ({ request }) => {
    test.setTimeout(60_000);
    const tab = await openIntegrations(page);
    github = await createWebhookViaUI(page, channelId, GITHUB_NAME, 'github');
    expect(github.secret, 'the GitHub panel shows a signing secret').toBeTruthy();
    const secret = github.secret as string;
    const reveal = page.getByTestId('webhook-reveal');
    await expect(reveal.getByTestId('webhook-reveal-warning')).toContainText('shown once');
    const setup = reveal.getByTestId('github-setup');
    await expect(setup).toBeVisible();
    await expect(setup.getByTestId('github-setup-url')).toContainText(github.url);
    await expect(setup.getByTestId('github-setup-content-type')).toContainText('application/json');
    await expect(setup.getByTestId('github-setup-secret')).toContainText(secret);
    await expect(reveal.getByTestId('webhook-reveal-curl')).toHaveCount(0);
    await closeReveal(page);

    const row = tab.getByTestId(`webhook-row-${github.id}`);
    await expect(row.getByTestId('webhook-type')).toHaveText('GitHub', { timeout: 15_000 });
    await expect(row.getByTestId('webhook-channel')).toHaveText(CHANNEL);
    await expect(tab.getByTestId('integrations-count')).toContainText(`2 of ${maxWebhooks}`);
    await expect(page.locator('body')).not.toContainText(secret);
    await closeSettings(page);

    // The fixture's RAW bytes, signed as they are sent (never re-serialised)
    const body = Buffer.from(readFileSync(PUSH_FIXTURE, 'utf8'), 'utf8');
    const signed = await pushDelivery(request, github.url, body, githubSignature(body, secret));
    expect(signed.status()).toBe(204);

    const push = messageRow(page, 'pushed 3 commits to');
    await expect(push).toHaveCount(1, { timeout: 15_000 });
    await expectPlainWebhookAuthor(push, GITHUB_NAME);
    await expect(push).toContainText('wile-e pushed 3 commits to main in acme/rocket');
    await expect(push.locator('a[href^="https://github.com/acme/rocket/compare/"]')).toHaveText('acme/rocket');
    await expect(push.locator('a[href^="https://github.com/acme/rocket/commit/"]')).toHaveCount(3);
    await expect(push).toContainText('Add launch countdown timer');

    // The same bytes without a signature, or signed with another secret: refused, nothing posted
    const unsigned = await pushDelivery(request, github.url, body);
    expect(unsigned.status()).toBe(401);
    expect(await unsigned.json()).toEqual({ success: false, error: 'Invalid signature' });
    const misSigned = await pushDelivery(request, github.url, body, githubSignature(body, `${secret}x`));
    expect(misSigned.status()).toBe(401);
    expect(await misSigned.json()).toEqual({ success: false, error: 'Invalid signature' });
    await expect(messageRow(page, 'pushed 3 commits to')).toHaveCount(1);
  });

  test('rotate the generic webhook: the panel shows a new URL, the old one is dead at once', async ({ request }) => {
    test.setTimeout(60_000);
    const tab = await openIntegrations(page);
    await tab.getByTestId(`webhook-row-${generic.id}`).getByTestId('webhook-rotate').click();
    const confirm = page.getByTestId('webhook-rotate-dialog');
    await expect(confirm).toContainText(GENERIC_NAME);
    await confirm.getByTestId('webhook-rotate-dialog-confirm').click();
    await expect(confirm).toHaveCount(0, { timeout: 15_000 });

    const rotated = await readReveal(page);
    await expect(page.getByTestId('webhook-reveal')).toContainText(`New URL for ${GENERIC_NAME}`);
    expect(rotated.id).toBe(generic.id);
    expect(rotated.token).not.toBe(generic.token);
    expect(rotated.url).not.toBe(generic.url);
    await closeReveal(page);

    await expectNotFound(await request.post(generic.url, { data: { content: `old URL ${stamp}` } }));
    const fresh = await request.post(rotated.url, { data: { content: rotatedContent } });
    expect(fresh.status()).toBe(204);
    // the open channel (behind the settings) gets it live, under the same webhook
    await expect(messageRow(page, rotatedContent)).toHaveCount(1, { timeout: 15_000 });
    await expect(messageRow(page, `old URL ${stamp}`)).toHaveCount(0);
    generic = rotated;
    await closeSettings(page);
  });

  test('delete with purge: the webhook\'s messages leave the open channel live, the other webhook\'s stay, the URL is a 404', async ({ request }) => {
    test.setTimeout(90_000);
    await expect(messageRow(page, genericContent)).toHaveCount(1);
    await expect(messageRow(page, rotatedContent)).toHaveCount(1);
    await expect(messageRow(page, 'pushed 3 commits to')).toHaveCount(1);

    const tab = await openIntegrations(page);
    await tab.getByTestId(`webhook-row-${generic.id}`).getByTestId('webhook-delete').click();
    const confirm = page.getByTestId('webhook-delete-dialog');
    await expect(confirm).toContainText(GENERIC_NAME);
    const purge = confirm.getByTestId('webhook-delete-purge');
    await expect(purge).not.toBeChecked();
    await purge.check();
    await confirm.getByTestId('webhook-delete-dialog-confirm').click();
    await expect(confirm).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByTestId('toast-container')).toContainText(`${GENERIC_NAME} deleted, along with 2 messages`, { timeout: 15_000 });

    await expect(tab.getByTestId(`webhook-row-${generic.id}`)).toHaveCount(0, { timeout: 15_000 });
    await expect(tab.getByTestId(`webhook-row-${github.id}`)).toBeVisible();
    await expect(tab.getByTestId('integrations-count')).toContainText(`1 of ${maxWebhooks}`);

    // Live, without a reload (message:bulk_deleted): only THIS webhook's rows go
    await expect(messageRow(page, genericContent)).toHaveCount(0, { timeout: 15_000 });
    await expect(messageRow(page, rotatedContent)).toHaveCount(0, { timeout: 15_000 });
    await expect(messageRow(page, 'pushed 3 commits to')).toHaveCount(1);
    await closeSettings(page);

    await expectNotFound(await request.post(generic.url, { data: { content: `after delete ${stamp}` } }));

    // The purge is the server's, not only the client's: still gone after a reload
    await page.reload();
    await openChannel(page);
    await expect(messageRow(page, 'pushed 3 commits to')).toHaveCount(1, { timeout: 15_000 });
    await expect(messageRow(page, genericContent)).toHaveCount(0);
    await expect(messageRow(page, rotatedContent)).toHaveCount(0);
  });
});
