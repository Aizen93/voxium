// A hostile server (docs/e2e-dm-spec.md §1 threat model) cannot write words a
// contact never wrote — but it holds every ciphertext they ever sent, and a
// Megolm ciphertext decrypts forever. Before ratchet positions were bound to
// one message, it could choose WHICH of the contact's past words appear WHEN:
// re-serve an old message under a new id (page or socket), label an unedited
// message as edited, or roll an edit back to an older ciphertext. Each of
// those must render as "Unable to decrypt this message", and the authentic
// messages must still render exactly once.
import type { APIRequestContext, Page, Route } from '@playwright/test';
import { test, expect } from './helpers/fixtures';
import { testUser, injectAuth } from './helpers/auth';
import { registerUser, sendFriendRequest, acceptFriendRequest, clearRateLimits, API_URL } from './helpers/api';
import { dmHeading } from './helpers/selectors';

const MARKER = 'Unable to decrypt this message';

async function rewriteJson(route: Route, edit: (body: any) => void) {
  const response = await route.fetch();
  const body = await response.json();
  edit(body);
  await route.fulfill({ response, json: body });
}

async function waitDevice(request: APIRequestContext, token: string, userId: string) {
  await expect.poll(async () => {
    const res = await request.get(`${API_URL}/e2e/devices/${userId}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok()) return 0;
    const b = await res.json();
    return b.data?.devices?.length ?? 0;
  }, { timeout: 30_000 }).toBeGreaterThan(0);
}

const bubble = (page: Page, text: string) => page.locator('.leading-relaxed', { hasText: text });

test('a hostile server’s replayed, relabelled and rolled-back ciphertext never renders as authentic', async ({ page, request, browser }) => {
  test.setTimeout(180_000);
  const alice = await registerUser(request, testUser('rpla'));
  const bobUser = testUser('rplb');
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

  // ── Alice sends two authentic encrypted DMs: positions 0 and 1 of her session ──
  await injectAuth(page, alice);
  await expect(dmHeading(page)).toBeVisible({ timeout: 20_000 });
  await waitDevice(request, bob.accessToken, alice.user.id);
  await page.getByText('Friends').first().click();
  await page.getByText('All', { exact: true }).click();
  await page.locator('button[title="Message"]').first().click();
  await expect(page.locator('textarea')).toBeVisible({ timeout: 10_000 });
  const stamp = Date.now();
  const a1 = `replay first ${stamp}`;
  const a2 = `replay second ${stamp}`;
  for (const text of [a1, a2]) {
    const posted = page.waitForResponse((r) => r.request().method() === 'POST' && /\/dm\/[^/]+\/messages$/.test(r.url()), { timeout: 20_000 });
    await page.locator('textarea').fill(text);
    await page.keyboard.press('Enter');
    const res = await posted;
    expect(res.status(), `POST for "${text}": ${await res.text()}`).toBe(201);
    await expect(page.locator('textarea')).toHaveValue('', { timeout: 15_000 });
    await expect(bubble(page, text)).toBeVisible({ timeout: 15_000 });
  }

  // Alice's REAL rows, as the server stores them (ascending createdAt)
  const convs = await (await request.get(`${API_URL}/dm`, { headers: { Authorization: `Bearer ${bob.accessToken}` } })).json();
  const conversationId: string = convs.data[0].id;
  const fetchReal = async () => {
    const res = await request.get(`${API_URL}/dm/${conversationId}/messages`, { headers: { Authorization: `Bearer ${bob.accessToken}` } });
    const rows = (await res.json()).data as any[];
    return rows.filter((m) => m.author?.id === alice.user.id && m.encrypted === true)
      .sort((x, y) => Date.parse(x.createdAt) - Date.parse(y.createdAt));
  };
  // the bubble can render before the POST has landed
  await expect.poll(async () => (await fetchReal()).length, { timeout: 20_000 }).toBe(2);
  const real = await fetchReal();
  const [row1, row2] = real;
  for (const r of real) expect(r.content).toMatch(/^\{"v":1,"e":"megolm1"/);
  expect(row1.content).not.toBe(row2.content);

  // ── Bob reads both, untouched: this device binds position 0 → A1, 1 → A2 ──
  const aliceRow = () => bobPage.getByText(alice.user.username, { exact: true }).first();
  await aliceRow().click();
  await expect(bubble(bobPage, a1)).toHaveCount(1, { timeout: 20_000 });
  await expect(bubble(bobPage, a2)).toHaveCount(1, { timeout: 20_000 });
  await expect(bobPage.getByText(MARKER)).toHaveCount(0);

  // ── The hostile server rewrites Bob's message pages from here on ──
  const freshAt = (s: number) => new Date(Date.now() + s * 1000).toISOString();
  let relabelA2 = false;
  await bobPage.route(/\/api\/v1\/dm\/[^/]+\/messages(\?.*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    return rewriteJson(route, (body) => {
      // (1) A1's authentic envelope under a NEW id and a fresh createdAt
      body.data.push({ ...row1, id: 'replay-page', createdAt: freshAt(1), editedAt: null, reactions: [], replyTo: null });
      // (3) A2's ORIGINAL envelope, labelled as an edit it never had
      if (relabelA2) for (const m of body.data) if (m.id === row2.id) m.editedAt = freshAt(2);
    });
  });

  const reopen = async () => {
    // two browsers on one IP and a reload per step: the global per-IP bucket (100/min when written, 1000/min now)
    // is a harness property, not the behaviour under test (helpers/rateLimits.ts)
    await clearRateLimits();
    await bobPage.reload();
    await expect(dmHeading(bobPage)).toBeVisible({ timeout: 20_000 });
    await expect(aliceRow()).toBeVisible({ timeout: 15_000 });
    await aliceRow().click();
  };

  // (1) Page replay: A1 once, the replayed row is the marker
  await reopen();
  await expect(bubble(bobPage, a1)).toHaveCount(1, { timeout: 20_000 });
  await expect(bubble(bobPage, a2)).toHaveCount(1, { timeout: 20_000 });
  await expect(bobPage.getByText(MARKER)).toHaveCount(1, { timeout: 15_000 });

  // (2) Socket replay: A1's envelope again under another new id
  expect(forgeSocket, 'the socket must have upgraded to a websocket we route').not.toBeNull();
  forgeSocket!(`42${JSON.stringify(['dm:message:new', {
    ...row1, id: 'replay-socket', createdAt: freshAt(3), editedAt: null, reactions: [], replyTo: null,
  }])}`);
  await expect(bobPage.getByText(MARKER)).toHaveCount(2, { timeout: 15_000 });
  await expect(bubble(bobPage, a1)).toHaveCount(1);
  await expect(bubble(bobPage, a2)).toHaveCount(1);

  // (3) Relabel: A2's original ciphertext served with editedAt set → refused
  relabelA2 = true;
  await reopen();
  await expect(bubble(bobPage, a1)).toHaveCount(1, { timeout: 20_000 });
  // the page replay + the relabelled A2 (the socket replay is gone with the reload)
  await expect(bobPage.getByText(MARKER)).toHaveCount(2, { timeout: 15_000 });
  await expect(bubble(bobPage, a2)).toHaveCount(0);

  // (4) Rollback over the socket. First the honest A2 again: the refused
  // relabel must not have cost the device its authentic copy.
  relabelA2 = false;
  await reopen();
  await expect(bubble(bobPage, a1)).toHaveCount(1, { timeout: 20_000 });
  await expect(bubble(bobPage, a2)).toHaveCount(1, { timeout: 20_000 });
  await expect(bobPage.getByText(MARKER)).toHaveCount(1, { timeout: 15_000 });
  // then an "edit" of A2 carrying A1's envelope (a lower index of the same session)
  forgeSocket!(`42${JSON.stringify(['dm:message:update', { ...row2, content: row1.content, editedAt: freshAt(4) }])}`);
  await expect(bobPage.getByText(MARKER)).toHaveCount(2, { timeout: 15_000 });
  await expect(bubble(bobPage, a2)).toHaveCount(0);
  await expect(bubble(bobPage, a1)).toHaveCount(1);

  await bobPage.unrouteAll({ behavior: 'wait' });
  await bobCtx.close();
});
