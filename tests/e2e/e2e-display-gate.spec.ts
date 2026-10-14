// A hostile server (or TLS-terminating hop — docs/e2e-dm-spec.md's threat
// model) forges the API and socket traffic of a real E2E DM session, and the
// victim's screen must show none of it: only the authentic message, the real
// call notice, and "Unable to decrypt" where a forged row stood. Every forgery
// here rendered on the client before the 2.1 display-gate work (the list
// preview printed the forged text under the contact's name).
import type { Page, Route } from '@playwright/test';
import { test, expect } from './helpers/fixtures';
import { testUser, injectAuth } from './helpers/auth';
import { registerUser, sendFriendRequest, acceptFriendRequest, API_URL } from './helpers/api';
import { dmHeading } from './helpers/selectors';

const F = {
  preview: 'FORGEDPREVIEW7',
  plain: 'FORGEDPLAIN7',
  plainFile: 'FORGEDPLAINFILE7.exe',
  system: 'FORGEDSYSTEM7',
  wireFile: 'FORGEDWIREFILE7.pdf',
  quote: 'FORGEDQUOTE7',
  ownQuote: 'FORGEDOWNQUOTE7',
  ownFile: 'FORGEDOWNFILE7.pdf',
  socket: 'FORGEDSOCKET7',
  socketFile: 'FORGEDSOCKETFILE7.exe',
  socketEdit: 'FORGEDSOCKETEDIT7',
};
const forgedE2EMeta = (fileName: string) => ({ s3Key: 'attachments/dm-x/evil', key: 'AAAA', iv: 'AAAA', fileName, fileSize: 10, mimeType: 'image/png' });
const forgedAttachment = (fileName: string) => ({ id: `att-${fileName}`, s3Key: 'attachments/dm-x/evil.bin', fileName, fileSize: 10, mimeType: 'application/octet-stream', expired: false });

async function rewriteJson(route: Route, edit: (body: any) => void) {
  const response = await route.fetch();
  const body = await response.json();
  edit(body);
  await route.fulfill({ response, json: body });
}

async function waitDevice(request: any, token: string, userId: string) {
  await expect.poll(async () => {
    const res = await request.get(`${API_URL}/e2e/devices/${userId}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok()) return 0;
    const b = await res.json();
    return b.data?.devices?.length ?? 0;
  }, { timeout: 30_000 }).toBeGreaterThan(0);
}

async function noForgery(page: Page, tokens: string[]) {
  for (const t of tokens) await expect(page.getByText(t, { exact: false }), `${t} must never render`).toHaveCount(0);
}

test('a hostile server’s forged API and socket traffic never reaches the screen', async ({ page, request, browser }) => {
  test.setTimeout(150_000);
  const alice = await registerUser(request, testUser('sima'));
  const bobUser = testUser('simb');
  const bob = await registerUser(request, bobUser);
  await sendFriendRequest(request, alice.accessToken, bobUser.username);
  await acceptFriendRequest(request, bob.accessToken, alice.user.id);
  // the conversation first: device lists are only served between users who share one
  const opened = await request.post(`${API_URL}/dm`, { data: { userId: bob.user.id }, headers: { Authorization: `Bearer ${alice.accessToken}` } });
  expect(opened.ok()).toBe(true);

  // ── Bob's browser: the victim. Socket routed through us from the start ──
  const bobCtx = await browser.newContext();
  let forgeSocket: ((frame: string) => void) | null = null;
  await bobCtx.routeWebSocket(/socket\.io/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => ws.send(m));
    forgeSocket = (frame) => ws.send(frame);
  });
  const bobPage = await bobCtx.newPage();
  await injectAuth(bobPage, bob);
  await expect(dmHeading(bobPage)).toBeVisible({ timeout: 20_000 });
  await waitDevice(request, alice.accessToken, bob.user.id);

  // ── Alice sends an authentic encrypted DM ──
  await injectAuth(page, alice);
  await expect(dmHeading(page)).toBeVisible({ timeout: 20_000 });
  await waitDevice(request, bob.accessToken, alice.user.id);
  await page.getByText('Friends').first().click();
  await page.getByText('All').click();
  await page.locator('button[title="Message"]').first().click();
  await expect(page.locator('textarea')).toBeVisible({ timeout: 10_000 });
  const authentic = `authentic hello ${Date.now()}`;
  await page.locator('textarea').fill(authentic);
  await page.keyboard.press('Enter');
  await expect(page.locator('.leading-relaxed', { hasText: authentic })).toBeVisible({ timeout: 15_000 });

  const convs = await (await request.get(`${API_URL}/dm`, { headers: { Authorization: `Bearer ${bob.accessToken}` } })).json();
  const conversationId: string = convs.data[0].id;

  // ── The hostile server rewrites Bob's API traffic from here on ──
  await bobPage.route(/\/api\/v1\/dm$/, (route) => rewriteJson(route, (body) => {
    for (const c of body.data) c.lastMessage = { id: 'never-seen', content: F.preview, encrypted: true, type: 'user', createdAt: new Date().toISOString(), authorId: alice.user.id };
  }));
  await bobPage.route(/\/api\/v1\/dm\/[^/]+\/messages(\?.*)?$/, async (route) => {
    if (route.request().method() === 'POST') {
      // the reply to Bob's own send
      return rewriteJson(route, (body) => {
        body.data.replyTo = { id: 'p-x', content: F.ownQuote, encrypted: false, author: { id: alice.user.id, username: 'alice', displayName: 'Alice' } };
        body.data.e2eAttachments = [forgedE2EMeta(F.ownFile)];
        body.data.mentions = [{ id: bob.user.id, username: 'mallory', displayName: 'Mallory' }];
      });
    }
    return rewriteJson(route, (body) => {
      const real = body.data[0];
      const author = real.author;
      for (const m of body.data) {
        m.e2eAttachments = [forgedE2EMeta(F.wireFile)];
        m.replyTo = { id: 'p-y', content: F.quote, encrypted: false, author };
        m.mentions = [{ id: bob.user.id, username: 'mallory', displayName: 'Mallory' }];
      }
      const base = { conversationId, channelId: null, author, editedAt: null, reactions: [], replyTo: null };
      const t = (s: number) => new Date(Date.parse(real.createdAt) + s * 1000).toISOString();
      body.data.push(
        { ...base, id: 'forged-plain', type: 'user', encrypted: false, content: F.plain, attachments: [forgedAttachment(F.plainFile)], createdAt: t(1) },
        { ...base, id: 'forged-system', type: 'system', encrypted: false, content: F.system, createdAt: t(2) },
        { ...base, id: 'real-notice', type: 'system', encrypted: false, content: 'Voice call started', createdAt: t(3) },
      );
    });
  });

  // reload: Bob's client refetches everything through the hostile server
  await bobPage.reload();
  await expect(dmHeading(bobPage)).toBeVisible({ timeout: 20_000 });

  // (1) the conversation list: a forged encrypted preview is locked
  const aliceRow = bobPage.getByText(alice.user.username, { exact: true }).first();
  await expect(aliceRow).toBeVisible({ timeout: 15_000 });
  await expect(bobPage.getByText('Encrypted message').first()).toBeVisible({ timeout: 10_000 });
  await noForgery(bobPage, [F.preview]);

  // (2) the conversation: the authentic message and the real notice, nothing forged
  await aliceRow.click();
  await expect(bobPage.locator('.leading-relaxed', { hasText: authentic })).toBeVisible({ timeout: 15_000 });
  await expect(bobPage.getByText('Voice call started').first()).toBeVisible();
  await expect(bobPage.getByText('Unable to decrypt this message')).toHaveCount(2);
  await noForgery(bobPage, [F.plain, F.plainFile, F.system, F.wireFile, F.quote, 'Mallory']);

  // (3) Bob's own send: the server's reply to the POST adds a quote, a file, a mention
  await waitDevice(request, bob.accessToken, alice.user.id);
  const own = `own reply ${Date.now()}`;
  const posted = bobPage.waitForResponse((r) => r.request().method() === 'POST' && /\/dm\/[^/]+\/messages$/.test(r.url()), { timeout: 20_000 });
  await bobPage.locator('textarea').fill(own);
  await bobPage.keyboard.press('Enter');
  expect((await posted).status()).toBe(201);
  await expect(bobPage.locator('textarea')).toHaveValue('', { timeout: 15_000 });
  await expect(bobPage.locator('.leading-relaxed', { hasText: own })).toBeVisible({ timeout: 15_000 });
  await noForgery(bobPage, [F.ownQuote, F.ownFile, 'Mallory']);

  // (4) the socket: a forged plaintext DM and a forged edit of the authentic one
  expect(forgeSocket, 'the socket must have upgraded to a websocket we route').not.toBeNull();
  const realRow = (await (await request.get(`${API_URL}/dm/${conversationId}/messages`, { headers: { Authorization: `Bearer ${bob.accessToken}` } })).json()).data[0];
  const author = realRow.author;
  forgeSocket!(`42${JSON.stringify(['dm:message:new', {
    id: 'forged-socket', conversationId, channelId: null, type: 'user', encrypted: false, content: F.socket,
    attachments: [forgedAttachment(F.socketFile)], e2eAttachments: [forgedE2EMeta(F.socketFile)],
    mentions: [{ id: bob.user.id, username: 'mallory', displayName: 'Mallory' }],
    author, createdAt: new Date().toISOString(), editedAt: null, reactions: [], replyTo: null,
  }])}`);
  forgeSocket!(`42${JSON.stringify(['dm:message:update', { ...realRow, encrypted: false, content: F.socketEdit, editedAt: new Date().toISOString() }])}`);
  // the forged new row is one more "unable to decrypt" marker, and the forged
  // unencrypted edit is refused too (it blanks the row it targets — the server
  // can always withhold a message; it must never put words in one): 2 + 2
  await expect(bobPage.getByText('Unable to decrypt this message')).toHaveCount(4, { timeout: 10_000 });
  await expect(bobPage.locator('.leading-relaxed', { hasText: authentic })).toHaveCount(0);
  await noForgery(bobPage, [F.socket, F.socketFile, F.socketEdit, 'Mallory']);

  await bobPage.unrouteAll({ behavior: 'wait' });
  await bobCtx.close();
});
