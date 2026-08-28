import type { Page, APIRequestContext } from '@playwright/test';
import { test, expect } from './helpers/fixtures';
import { testUser, injectAuth } from './helpers/auth';
import { registerUser, createServer, createInvite, joinServerViaInvite, API_URL } from './helpers/api';
import { findSecureChannelId } from './helpers/db';
import { clearRateLimits } from './helpers/rateLimits';

// Live four-client test of SECURE VOICE channels (docs/e2e-dm-spec.md §21):
// invite-only E2E voice where every Opus frame is encrypted client-side and
// the SFU forwards ciphertext it cannot read. The centerpiece is the
// CIPHERTEXT PROOF: a member who drops every inbound media key (a DEV-only
// test hook) receives frames but decrypts none — behaviorally equivalent to
// tapping the SFU, achievable entirely in Playwright.

const PANEL = '[data-testid="voice-panel"]';
const LOCK = '[data-testid="secure-voice-e2e-lock"]';
const CHANNEL = '[data-testid="secure-voice-channel-war-room"]';

interface Diag {
  encrypted: number;
  encryptDropped: number;
  receivers: Record<string, { ok: number; tagFailed: number; unknownKey: number }>;
}

function diagOf(page: Page): Promise<Diag | null> {
  return page.evaluate(async () => {
    const fn = (window as unknown as { __voxSecureVoiceDiag?: () => Promise<unknown> }).__voxSecureVoiceDiag;
    if (!fn) return null;
    // A transport restart legitimately tears the session down and re-begins
    // with a fresh key (the IV firewall). A probe landing in that gap gets a
    // 'destroyed' rejection — and a THROW inside expect.poll aborts the whole
    // poll rather than retrying. Report "no reading" and let the poll go on;
    // the rejoined session's counters satisfy it a moment later.
    try {
      return await fn();
    } catch {
      return null;
    }
  }) as Promise<Diag | null>;
}

async function okFrom(page: Page, senderUserId: string): Promise<number> {
  const diag = await diagOf(page);
  return diag?.receivers?.[senderUserId]?.ok ?? 0;
}

async function failedFrom(page: Page, senderUserId: string): Promise<number> {
  const diag = await diagOf(page);
  const r = diag?.receivers?.[senderUserId];
  return (r?.tagFailed ?? 0) + (r?.unknownKey ?? 0);
}

async function openServer(page: Page, serverName: string) {
  await page.getByRole('button', { name: serverName, exact: true }).click({ timeout: 15_000 });
  // Don't rely on the app auto-selecting #general: with four contexts on a
  // loaded CI runner the channel list renders but auto-select loses the race,
  // and the composer never appears. Click the channel ourselves once it
  // exists — idempotent when auto-select already won.
  await page.getByRole('button', { name: 'general' }).first().click({ timeout: 30_000 });
  await expect(page.locator('textarea')).toBeVisible({ timeout: 30_000 });
}

// RNNoise classifies the harness's steady fake-mic tone as noise and
// suppresses it to silence, so the 300ms silence gate pauses the producer
// at the SFU and the frame counters starve (blocks the Firefox run; Chromium's
// pulsed beep pattern only escapes by luck). This test is about E2E frames,
// not noise suppression — keep the fake mic "speaking".
function disableNoiseSuppression(page: Page) {
  return page.addInitScript(() => {
    window.localStorage.setItem('voxium_settings', JSON.stringify({ enableNoiseSuppression: false }));
  });
}

async function removeSecureMemberViaApi(request: APIRequestContext, token: string, serverId: string, channelId: string, userId: string) {
  const res = await request.delete(`${API_URL}/servers/${serverId}/secure-channels/${channelId}/members/${userId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.ok()).toBe(true);
}

test.describe('Secure voice channels — E2E audio through the SFU', () => {
  test('create, join, hear-only-with-keys, keyless member proof, eviction, teardown', async ({ page, request, browser }) => {
    test.setTimeout(300_000);

    // ── Setup: alice owns the server; charlie + dave join it; bob too (uninvited) ──
    const alice = testUser('sva');
    const bob = testUser('svb');
    const charlie = testUser('svc');
    const dave = testUser('svd');
    const dataA = await registerUser(request, alice);
    const dataB = await registerUser(request, bob);
    // Four registrations from one IP exceed the 3/min auth bucket — refill
    // (harness property; production users don't register in quadruplets)
    await clearRateLimits();
    const dataC = await registerUser(request, charlie);
    const dataD = await registerUser(request, dave);

    const server = await createServer(request, dataA.accessToken, 'War Council');
    await joinServerViaInvite(request, dataB.accessToken, await createInvite(request, dataA.accessToken, server.id));
    await joinServerViaInvite(request, dataC.accessToken, await createInvite(request, dataA.accessToken, server.id));
    await joinServerViaInvite(request, dataD.accessToken, await createInvite(request, dataA.accessToken, server.id));

    await disableNoiseSuppression(page);
    await injectAuth(page, dataA);
    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    await injectAuth(pageB, dataB);
    const contextC = await browser.newContext();
    const pageC = await contextC.newPage();
    await disableNoiseSuppression(pageC);
    await injectAuth(pageC, dataC);
    const contextD = await browser.newContext();
    const pageD = await contextD.newPage();
    // Dave drops every inbound media key (DEV-only hook) — installed before
    // the app loads so no key can slip through early
    await pageD.addInitScript(() => {
      (window as unknown as { __VOX_SECURE_VOICE_TEST__?: object }).__VOX_SECURE_VOICE_TEST__ = { dropInboundKeys: true };
    });
    await disableNoiseSuppression(pageD);
    // Three app boots from one IP have nearly drained the 100/min global
    // bucket — refill BEFORE the fourth boots. On CI this failed for real:
    // dave's server-detail and member fetches came back 429, the client does
    // not retry them, and his channel list stayed empty for the whole test
    // (proved by the run's network trace, six 429s on page D).
    await clearRateLimits();
    await injectAuth(pageD, dataD);

    // Same budget property for the four server opens (~6 requests each)
    await clearRateLimits();
    await openServer(page, 'War Council');
    await openServer(pageB, 'War Council');
    await openServer(pageC, 'War Council');
    await openServer(pageD, 'War Council');

    // Four contexts share one IP — refill the global bucket (harness property)
    await clearRateLimits();

    // ── 1. Alice creates a secure VOICE channel inviting charlie + dave ──
    await page.getByTestId('secure-channels-section').hover();
    await page.getByTestId('secure-channel-create-open').click();
    await page.getByTestId('secure-type-voice').click();
    await page.getByTestId('secure-channel-name').fill('war-room');
    await page.getByTestId(`secure-invite-${charlie.username}`).click();
    await page.getByTestId(`secure-invite-${dave.username}`).click();
    await page.getByTestId('secure-channel-create').click();

    await expect(page.locator(CHANNEL)).toBeVisible({ timeout: 15_000 });
    await expect(pageC.locator(CHANNEL)).toBeVisible({ timeout: 15_000 });
    await expect(pageD.locator(CHANNEL)).toBeVisible({ timeout: 15_000 });

    // ── 2. Opacity: bob (full server member) sees nothing ──
    await expect(pageB.locator(CHANNEL)).toHaveCount(0);

    // ── 3. Alice and charlie join — E2E session, lock shown, no screen share ──
    await page.locator(CHANNEL).click();
    await expect(page.locator(PANEL)).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(LOCK)).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(`${PANEL} button[title="Share Screen"]`)).toHaveCount(0);

    await pageC.locator(CHANNEL).click();
    await expect(pageC.locator(PANEL)).toBeVisible({ timeout: 20_000 });
    await expect(pageC.locator(LOCK)).toBeVisible({ timeout: 10_000 });

    // ── 4. Keyed members actually DECRYPT each other's audio ──
    // The fake mic produces a tone, speaking detection keeps producers live,
    // and the frame worker's ok-counters prove end-to-end decryption.
    await expect.poll(() => okFrom(page, dataC.user.id), { timeout: 30_000 }).toBeGreaterThan(0);
    await expect.poll(() => okFrom(pageC, dataA.user.id), { timeout: 30_000 }).toBeGreaterThan(0);

    // ── 5. CIPHERTEXT PROOF: dave (keyless by hook) hears NOTHING ──
    await pageD.locator(CHANNEL).click();
    await expect(pageD.locator(PANEL)).toBeVisible({ timeout: 20_000 });

    // Frames from alice arrive at dave and fail to decrypt — the SFU is
    // demonstrably forwarding audio dave cannot read...
    await expect.poll(() => failedFrom(pageD, dataA.user.id), { timeout: 30_000 }).toBeGreaterThan(0);
    const daveHeard = await okFrom(pageD, dataA.user.id);
    expect(daveHeard).toBe(0);
    // ...while the keyed pair keeps decrypting each other throughout
    const aliceOkBefore = await okFrom(page, dataC.user.id);
    await expect.poll(() => okFrom(page, dataC.user.id), { timeout: 30_000 }).toBeGreaterThan(aliceOkBefore);

    // ── 6. Eviction: removing dave from the channel force-leaves his voice ──
    const channelId = await findSecureChannelId(server.id, 'war-room');
    expect(channelId).not.toBeNull();
    await removeSecureMemberViaApi(request, dataA.accessToken, server.id, channelId!, dataD.user.id);
    await expect(pageD.locator(PANEL)).toHaveCount(0, { timeout: 20_000 });
    await expect(pageD.locator(CHANNEL)).toHaveCount(0, { timeout: 15_000 });

    // The survivors rotated to a fresh key and STILL decrypt each other
    const okAfterEvict = await okFrom(pageC, dataA.user.id);
    await expect.poll(() => okFrom(pageC, dataA.user.id), { timeout: 30_000 }).toBeGreaterThan(okAfterEvict);

    // ── 7. Rejoin-rotation: charlie leaves and rejoins — still audible ──
    await pageC.locator(`${PANEL} button[title="Disconnect"]`).click();
    await expect(pageC.locator(PANEL)).toHaveCount(0, { timeout: 10_000 });
    await pageC.locator(CHANNEL).click();
    await expect(pageC.locator(PANEL)).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => okFrom(pageC, dataA.user.id), { timeout: 30_000 }).toBeGreaterThan(0);

    // ── 8. Channel deletion tears down live voice for everyone ──
    const delRes = await request.delete(`${API_URL}/servers/${server.id}/channels/${channelId}`, {
      headers: { Authorization: `Bearer ${dataA.accessToken}` },
    });
    expect(delRes.ok()).toBe(true);
    await expect(page.locator(PANEL)).toHaveCount(0, { timeout: 20_000 });
    await expect(pageC.locator(PANEL)).toHaveCount(0, { timeout: 20_000 });

    await contextB.close();
    await contextC.close();
    await contextD.close();
  });
});
