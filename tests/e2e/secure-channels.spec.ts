import type { Page } from '@playwright/test';
import { test, expect } from './helpers/fixtures';
import { testUser, injectAuth } from './helpers/auth';
import { registerUser, createServer, createInvite, joinServerViaInvite } from './helpers/api';
import { getChannelMessagesServerState, getSecureChannelServerState, findSecureChannelId } from './helpers/db';
import { clearRateLimits } from './helpers/rateLimits';

// Live three-client test of secure channels (invite-only, E2E-encrypted):
// creation with a member picker, invisibility to a non-invited server member,
// cross-client encrypt/decrypt, removal (sidebar drop + no reading onward),
// re-invite (forward-only history), the opaque moderation count — finishing
// with DB-level proof that the server stored only Megolm ciphertext.

async function openServer(page: Page, serverName: string) {
  // Server tiles in the spaces strip expose the name as their accessible name
  await page.getByRole('button', { name: serverName, exact: true }).click({ timeout: 15_000 });
  await expect(page.locator('textarea')).toBeVisible({ timeout: 15_000 });
}

async function sendChannelMessage(page: Page, text: string) {
  await page.locator('textarea').first().fill(text);
  await page.locator('textarea').first().press('Enter');
  await expect(page.getByText(text).first()).toBeVisible({ timeout: 15_000 });
}

test.describe('Secure channels — invite-only E2E-encrypted', () => {
  test('create, exclude, encrypt, remove, re-invite, and ciphertext-only server state', async ({ page, request, browser }) => {
    test.setTimeout(240_000);

    // ── Setup: alice owns a server; bob and charlie join it ──
    const alice = testUser('seca');
    const bob = testUser('secb');
    const charlie = testUser('secc');
    const dataA = await registerUser(request, alice);
    const dataB = await registerUser(request, bob);
    const dataC = await registerUser(request, charlie);

    const server = await createServer(request, dataA.accessToken, 'Covert Ops HQ');
    // Invites are single-use — one per joiner
    await joinServerViaInvite(request, dataB.accessToken, await createInvite(request, dataA.accessToken, server.id));
    await joinServerViaInvite(request, dataC.accessToken, await createInvite(request, dataA.accessToken, server.id));

    await injectAuth(page, dataA);
    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    await injectAuth(pageB, dataB);
    const contextC = await browser.newContext();
    const pageC = await contextC.newPage();
    await injectAuth(pageC, dataC);

    // Everyone lands in the server (E2E devices register at app mount)
    await openServer(page, 'Covert Ops HQ');
    await openServer(pageB, 'Covert Ops HQ');
    await openServer(pageC, 'Covert Ops HQ');

    // Three contexts share one IP: registration + E2E init already burned most
    // of the 100/min global bucket (a harness property, not a product one —
    // see helpers/rateLimits.ts)
    await clearRateLimits();

    // ── 1. Alice creates a secure channel and invites ONLY charlie ──
    await page.getByTestId('secure-channels-section').hover();
    await page.getByTestId('secure-channel-create-open').click();
    await page.getByTestId('secure-channel-name').fill('black-site');
    await page.getByTestId(`secure-invite-${charlie.username}`).click();
    await page.getByTestId('secure-channel-create').click();

    // Alice sees it in her sidebar with the lock treatment
    await expect(page.getByTestId('secure-channel-black-site')).toBeVisible({ timeout: 15_000 });

    // ── 2. Charlie's sidebar gains the channel via the member-scoped event ──
    await expect(pageC.getByTestId('secure-channel-black-site')).toBeVisible({ timeout: 15_000 });

    // ── 3. Bob — a full server member — sees NOTHING ──
    await expect(pageB.getByTestId('secure-channel-black-site')).toHaveCount(0);
    // (bob has no create permission either, so no secure section at all)
    await expect(pageB.getByTestId('secure-channels-section')).toHaveCount(0);

    // ── 4. Encrypted messages flow between the members ──
    await page.getByTestId('secure-channel-black-site').click();
    const secret1 = `the eagle lands at dawn ${Date.now()}`;
    await sendChannelMessage(page, secret1);

    await pageC.getByTestId('secure-channel-black-site').click();
    await expect(pageC.getByText(secret1).first()).toBeVisible({ timeout: 20_000 });

    const reply = `acknowledged, moving out ${Date.now()}`;
    await sendChannelMessage(pageC, reply);
    await expect(page.getByText(reply).first()).toBeVisible({ timeout: 20_000 });

    // ── 5. DB-level proof: the server stored ONLY ciphertext envelopes ──
    const channelId = await findSecureChannelId(server.id, 'black-site');
    expect(channelId).toBeTruthy();
    const channelState = await getSecureChannelServerState(channelId!);
    expect(channelState?.secure).toBe(true);
    expect(channelState?.createdById).toBe(dataA.user.id);
    const storedRows = await getChannelMessagesServerState(channelId!);
    expect(storedRows.length).toBeGreaterThanOrEqual(2);
    for (const row of storedRows) {
      expect(row.encrypted).toBe(true);
      // Megolm envelope, never the plaintext
      expect(row.content).toMatch(/^\{"v":1,"e":"megolm1"/);
      expect(row.content).not.toContain('the eagle lands');
      expect(row.content).not.toContain('acknowledged, moving out');
    }

    // ── 6. Removal: charlie loses the channel and everything after ──
    await page.getByTestId('secure-channel-black-site').click({ button: 'right' });
    await page.getByTestId('secure-channel-members').click();
    await expect(page.getByTestId('secure-members-list')).toBeVisible({ timeout: 10_000 });
    // remove charlie (the only non-creator row has the remove button)
    await page.locator(`[data-testid="secure-members-list"] button[title]`).first().click();
    await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // Charlie's sidebar drops the channel
    await expect(pageC.getByTestId('secure-channel-black-site')).toHaveCount(0, { timeout: 15_000 });

    // Alice keeps talking — a message charlie must never be able to read
    await page.getByTestId('secure-channel-black-site').click();
    const whileRemoved = `sent while charlie was out ${Date.now()}`;
    await sendChannelMessage(page, whileRemoved);

    // ── 7. Re-invite: forward-only — the removed-window message stays sealed ──
    await clearRateLimits();
    await page.getByTestId('secure-channel-black-site').click({ button: 'right' });
    await page.getByTestId('secure-channel-members').click();
    await page.getByTestId('secure-invite-open').click();
    await page.getByTestId(`secure-invite-${charlie.username}`).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    await expect(pageC.getByTestId('secure-channel-black-site')).toBeVisible({ timeout: 15_000 });

    // Charlie opens the channel FIRST, so the post-rejoin message reaches him
    // both live (socket → decrypt-on-arrival) and via the history fetch
    await pageC.getByTestId('secure-channel-black-site').click();

    const postRejoin = `welcome back, new key in effect ${Date.now()}`;
    await sendChannelMessage(page, postRejoin);

    // Charlie reads the post-rejoin message…
    await expect(pageC.getByText(postRejoin).first()).toBeVisible({ timeout: 30_000 });
    // …but the message sent while removed never yields plaintext for him
    await expect(pageC.getByText(whileRemoved)).toHaveCount(0);

    // ── 8. Opaque moderation: the owner's settings show a COUNT, nothing more ──
    await page.getByRole('button', { name: /server settings/i }).first().click();
    await expect(page.getByTestId('secure-moderation-delete-id')).toBeVisible({ timeout: 10_000 });

    await contextB.close();
    await contextC.close();
  });

  test('the server stores only Megolm envelopes for a secure channel', async ({ request }) => {
    // Pure API + DB flow (no UI): creator makes a channel, sends ciphertext,
    // and the stored rows are envelopes — a plaintext send is refused outright.
    const owner = testUser('secdb');
    const data = await registerUser(request, owner);
    const server = await createServer(request, data.accessToken, 'Envelope Proof');

    const createRes = await request.post(`http://localhost:3001/api/v1/servers/${server.id}/secure-channels`, {
      headers: { Authorization: `Bearer ${data.accessToken}` },
      data: { name: 'sealed', memberIds: [] },
    });
    expect(createRes.ok()).toBeTruthy();
    const channel = (await createRes.json()).data;

    const dbChannel = await getSecureChannelServerState(channel.id);
    expect(dbChannel?.secure).toBe(true);
    expect(dbChannel?.createdById).toBe(data.user.id);
    expect(dbChannel?.members).toEqual([{ userId: data.user.id, isCreator: true }]);

    // A plaintext send is a hard 400 — no silent downgrade
    const plainRes = await request.post(`http://localhost:3001/api/v1/channels/${channel.id}/messages`, {
      headers: { Authorization: `Bearer ${data.accessToken}` },
      data: { content: 'plaintext should be refused' },
    });
    expect(plainRes.status()).toBe(400);

    // A structurally valid envelope is stored VERBATIM with encrypted: true
    const envelope = '{"v":1,"e":"megolm1","sid":"c2Vzc2lvbklk","b":"Y2lwaGVydGV4dA"}';
    const cipherRes = await request.post(`http://localhost:3001/api/v1/channels/${channel.id}/messages`, {
      headers: { Authorization: `Bearer ${data.accessToken}` },
      data: { content: envelope, encrypted: true },
    });
    expect(cipherRes.ok()).toBeTruthy();

    const rows = await getChannelMessagesServerState(channel.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].encrypted).toBe(true);
    expect(rows[0].content).toBe(envelope);
  });
});
