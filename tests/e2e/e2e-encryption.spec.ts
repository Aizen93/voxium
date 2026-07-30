import type { Page } from '@playwright/test';
import { test, expect } from './helpers/fixtures';
import { testUser, injectAuth } from './helpers/auth';
import { registerUser, sendFriendRequest, acceptFriendRequest, API_URL } from './helpers/api';
import { getConversationServerState, getE2EDevices, getE2EKeyShareCount } from './helpers/db';

// Live two-client smoke test of the full E2E DM flow (docs/e2e-dm-spec.md):
// enable + badge, cross-client encrypt/decrypt, matching safety numbers,
// encrypted edits, encrypted attachments — finishing with DB-level proof
// that the server only ever stored ciphertext and opaque blobs.

// 1x1 red PNG
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

const BADGE = 'button[title="End-to-end encrypted — view safety number"]';
const BADGE_NEW_DEVICE = 'button[title="New device added — review devices"]';
const BADGE_OWN_DEVICE = 'button[title="A device was added to your account — review it"]';
const BADGE_UNSIGNED = 'button[title="A device is not signed by the account key — review it"]';

/** Open the DM with a user from the Friends list. */
async function openDMWith(page: Page, username: string) {
  await page.getByText('Friends').first().click();
  await page.getByText('All').click();
  await expect(page.getByText(username, { exact: true }).first()).toBeVisible({ timeout: 10_000 });
  await page.locator('button[title="Message"]').first().click();
  await expect(page.locator('textarea')).toBeVisible({ timeout: 10_000 });
}

async function sendMessage(page: Page, text: string) {
  await page.locator('textarea').first().fill(text);
  await page.locator('textarea').first().press('Enter');
  await expect(page.getByText(text).first()).toBeVisible({ timeout: 15_000 });
}

/** The 60-digit safety number shown in the modal, as one string. */
async function readSafetyNumber(page: Page): Promise<string> {
  await page.locator('button[title="End-to-end encrypted — view safety number"]').click();
  const groups = page.locator('div.select-all').first().locator('span');
  await expect(groups).toHaveCount(12, { timeout: 15_000 });
  const digits = (await groups.allTextContents()).join('');
  expect(digits).toMatch(/^\d{60}$/);
  return digits;
}

async function closeModal(page: Page) {
  await page.keyboard.press('Escape');
  // ModalShell closes on backdrop click; Escape is handled by SearchModal only —
  // click the backdrop to be safe
  const backdrop = page.locator('div.fixed.inset-0.z-50').first();
  if (await backdrop.isVisible().catch(() => false)) {
    await backdrop.click({ position: { x: 5, y: 5 } });
  }
}

test.describe('E2E encrypted DMs — live two-client smoke test', () => {
  test('badge, safety numbers, edits, attachments, and ciphertext-only server state', async ({ page, request, browser }) => {
    test.setTimeout(180_000);

    // ── Setup: two users, friends, second client ──
    const userA = testUser('e2ea');
    const userB = testUser('e2eb');
    const dataA = await registerUser(request, userA);
    const dataB = await registerUser(request, userB);
    await sendFriendRequest(request, dataA.accessToken, userB.username);
    await acceptFriendRequest(request, dataB.accessToken, dataA.user.id);

    await injectAuth(page, dataA);
    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    await injectAuth(pageB, dataB);

    // A: open the DM via Friends → Message
    await page.getByText('Friends').first().click();
    await page.getByText('All').click();
    await expect(page.getByText(userB.username, { exact: true }).first()).toBeVisible({ timeout: 10_000 });
    await page.locator('button[title="Message"]').first().click();
    await expect(page.locator('textarea')).toBeVisible({ timeout: 10_000 });

    // ── 1. Enable encryption (device registration must have completed) ──
    const enableButton = page.locator('button[title="Enable end-to-end encryption"]');
    await expect(enableButton).toBeVisible({ timeout: 20_000 }); // e2eReady + WASM init
    await enableButton.click();
    await page.getByRole('button', { name: 'Enable encryption', exact: true }).click();

    // system notice + lock badge on A
    await expect(page.getByText('End-to-end encryption enabled — new messages are secured').first()).toBeVisible({ timeout: 10_000 });
    const badgeA = page.locator('button[title="End-to-end encrypted — view safety number"]');
    await expect(badgeA).toBeVisible({ timeout: 10_000 });

    // ── 2. Encrypted messages flow both ways ──
    const secretA = `top secret from A ${Date.now()}`;
    await page.locator('textarea').fill(secretA);
    await page.keyboard.press('Enter');
    await expect(page.getByText(secretA).first()).toBeVisible({ timeout: 10_000 });

    // B opens the conversation, sees the DECRYPTED text + badge
    await expect(pageB.getByText(userA.username, { exact: true }).first()).toBeVisible({ timeout: 10_000 });
    await pageB.getByText(userA.username, { exact: true }).first().click();
    await expect(pageB.getByText(secretA).first()).toBeVisible({ timeout: 15_000 });
    await expect(pageB.locator('button[title="End-to-end encrypted — view safety number"]')).toBeVisible({ timeout: 15_000 });

    const secretB = `encrypted reply from B ${Date.now()}`;
    await pageB.locator('textarea').fill(secretB);
    await pageB.keyboard.press('Enter');
    await expect(pageB.getByText(secretB).first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(secretB).first()).toBeVisible({ timeout: 15_000 });

    // ── 3. Safety numbers match on both sides ──
    const safetyA = await readSafetyNumber(page);
    const safetyB = await readSafetyNumber(pageB);
    expect(safetyA).toBe(safetyB);

    // mark verified on A
    await page.getByRole('button', { name: 'Mark account as verified' }).click();
    await expect(page.getByText('Verified', { exact: true }).first()).toBeVisible();
    await closeModal(page);
    await closeModal(pageB);

    // ── 4. Encrypted edit propagates ──
    const editedText = `${secretA} (now edited)`;
    const messageRow = page.locator(`[data-message-id]`, { hasText: secretA }).first();
    await messageRow.hover();
    await messageRow.locator('button[title="Edit message"]').click();
    const editBox = messageRow.locator('textarea');
    await editBox.fill(editedText);
    await editBox.press('Enter');
    await expect(page.getByText(editedText).first()).toBeVisible({ timeout: 10_000 });
    await expect(pageB.getByText(editedText).first()).toBeVisible({ timeout: 15_000 });

    // ── 5. Encrypted attachment round-trip ──
    await page.locator('input[type="file"]').setInputFiles({
      name: 'pixel.png',
      mimeType: 'image/png',
      buffer: TINY_PNG,
    });
    // wait for the client-side encrypt + S3 upload to finish
    await expect(page.getByText('Uploading', { exact: false })).toBeHidden({ timeout: 30_000 });
    await page.locator('textarea').first().fill('here is an encrypted file');
    await page.locator('textarea').first().press('Enter');

    // sender renders the decrypted image with its REAL name from the payload
    await expect(page.locator('img[alt="pixel.png"]')).toBeVisible({ timeout: 20_000 });
    const srcA = await page.locator('img[alt="pixel.png"]').getAttribute('src');
    expect(srcA).toMatch(/^blob:/); // decrypted locally, never a server URL

    // receiver downloads + decrypts it live
    await expect(pageB.locator('img[alt="pixel.png"]')).toBeVisible({ timeout: 20_000 });
    expect(await pageB.locator('img[alt="pixel.png"]').getAttribute('src')).toMatch(/^blob:/);

    // ── 6. The server only ever saw ciphertext ──
    const conversation = await getConversationServerState(dataA.user.id, dataB.user.id);
    expect(conversation).toBeTruthy();
    expect(conversation!.encryptedAt).toBeTruthy();

    const userMessages = conversation!.messages.filter((m) => m.type === 'user');
    expect(userMessages.length).toBeGreaterThanOrEqual(3); // secretA(edited), secretB, attachment msg
    for (const m of userMessages) {
      expect(m.encrypted).toBe(true);
      // multi-device sends use the Megolm group envelope; olm1 is only the
      // pairwise key-share transport and pre-multi-device history
      expect(m.content).toMatch(/^\{"v":1,"e":"megolm1","sid":"[A-Za-z0-9+/]+","b":"[A-Za-z0-9+/]+"\}$/);
      // none of the plaintexts may appear anywhere in stored content
      for (const secret of [secretA, secretB, editedText, 'pixel.png', 'encrypted file']) {
        expect(m.content).not.toContain(secret);
      }
    }

    // attachment row is fully opaque: no real name, type, or plaintext size
    const attachmentRows = userMessages.flatMap((m) => m.attachments);
    expect(attachmentRows).toHaveLength(1);
    expect(attachmentRows[0].fileName).toBe('encrypted.bin');
    expect(attachmentRows[0].mimeType).toBe('application/octet-stream');
    expect(attachmentRows[0].s3Key).toMatch(/-encrypted\.bin$/);
    expect(attachmentRows[0].fileSize).toBe(TINY_PNG.length + 16); // ciphertext = plaintext + GCM tag

    // and the server refuses plaintext into this conversation (no downgrade)
    const downgrade = await request.post(`${API_URL}/dm/${conversation!.id}/messages`, {
      headers: { Authorization: `Bearer ${dataA.accessToken}` },
      data: { content: 'plaintext sneaking in' },
    });
    expect(downgrade.status()).toBe(400);

    await contextB.close();
  });

  test('multi-device: second device receives key shares, and loses access after revocation', async ({ page, request, browser }) => {
    test.setTimeout(180_000);

    // ── Setup: A (device 1) and B, friends, encrypted DM ──
    const userA = testUser('mda');
    const userB = testUser('mdb');
    const dataA = await registerUser(request, userA);
    const dataB = await registerUser(request, userB);
    await sendFriendRequest(request, dataA.accessToken, userB.username);
    await acceptFriendRequest(request, dataB.accessToken, dataA.user.id);

    await injectAuth(page, dataA); // A, device 1
    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    await injectAuth(pageB, dataB);

    await openDMWith(page, userB.username);
    const enableButton = page.locator('button[title="Enable end-to-end encryption"]');
    await expect(enableButton).toBeVisible({ timeout: 20_000 });
    await enableButton.click();
    await page.getByRole('button', { name: 'Enable encryption', exact: true }).click();
    await expect(page.locator(BADGE)).toBeVisible({ timeout: 10_000 });

    // B opens the conversation so both clients are live
    await expect(pageB.getByText(userA.username, { exact: true }).first()).toBeVisible({ timeout: 10_000 });
    await pageB.getByText(userA.username, { exact: true }).first().click();

    const beforeSecond = `sent before the second device ${Date.now()}`;
    await sendMessage(page, beforeSecond);
    await expect(pageB.getByText(beforeSecond).first()).toBeVisible({ timeout: 15_000 });

    expect(await getE2EDevices(dataA.user.id)).toHaveLength(1);

    // ── A signs in on a SECOND device (fresh context ⇒ fresh vault ⇒ new deviceId) ──
    const contextA2 = await browser.newContext();
    const pageA2 = await contextA2.newPage();
    await injectAuth(pageA2, dataA);
    await expect(pageA2.getByRole('heading', { name: 'Direct Messages' }).first()).toBeVisible({ timeout: 20_000 });

    await expect
      .poll(async () => (await getE2EDevices(dataA.user.id)).length, { timeout: 30_000 })
      .toBe(2);
    const devices = await getE2EDevices(dataA.user.id);
    const secondDeviceId = devices[1].deviceId;
    // distinct identity keys per device — never a copy of the first
    expect(devices[0].curve25519Key).not.toBe(devices[1].curve25519Key);

    // ── B sees the new device as UNSIGNED, not merely "new" ──
    // A's second device is not yet vouched for by A's account key, and that is
    // a cryptographic fact rather than a judgement call (spec §14.3).
    const afterSecondB = `reply after A added a device ${Date.now()}`;
    await sendMessage(pageB, afterSecondB);
    await expect(pageB.locator(BADGE_UNSIGNED)).toBeVisible({ timeout: 20_000 });

    // ── The second device decrypts BOTH directions ──
    await pageA2.getByText(userB.username, { exact: true }).first().click({ timeout: 20_000 });
    // B's message was encrypted to a session shared with device 2
    await expect(pageA2.getByText(afterSecondB).first()).toBeVisible({ timeout: 30_000 });

    // and A's own device 1 fans its key to device 2 (decrypt-to-self across devices)
    const fromDevice1 = `from device one after fanout ${Date.now()}`;
    await sendMessage(page, fromDevice1);
    await expect(pageA2.getByText(fromDevice1).first()).toBeVisible({ timeout: 30_000 });

    // device 2 can send too, and device 1 reads it
    const fromDevice2 = `from device two ${Date.now()}`;
    await sendMessage(pageA2, fromDevice2);
    await expect(page.getByText(fromDevice2).first()).toBeVisible({ timeout: 30_000 });
    await expect(pageB.getByText(fromDevice2).first()).toBeVisible({ timeout: 30_000 });

    // history predating the device stays unreadable there (no key backup, spec §11)
    await expect(pageA2.getByText(beforeSecond)).toHaveCount(0);

    // ── Approving the device makes the peer's warning disappear on its own ──
    // THE cross-signing payoff: once A's account key vouches for the device,
    // B's client verifies the chain and stops prompting — no second safety
    // number to compare, no dialog to dismiss.
    // A's own badge names the precise problem: a device its account key has
    // not signed yet.
    await expect(page.locator(BADGE_UNSIGNED)).toBeVisible({ timeout: 20_000 });
    await page.locator(BADGE_UNSIGNED).click();
    await page.locator('button[title="Manage devices"]').click();
    await expect(page.getByText('Your devices')).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Approve this device' }).first().click();
    await expect(page.getByRole('button', { name: 'Approve this device' })).toHaveCount(0, { timeout: 20_000 });
    await page.getByRole('button', { name: 'Close' }).last().click();
    await closeModal(page);

    const afterApproval = `sent after approving device two ${Date.now()}`;
    await sendMessage(page, afterApproval);
    await expect(pageB.getByText(afterApproval).first()).toBeVisible({ timeout: 20_000 });

    // B re-reads A's device list on its next send (the rotation decision), sees
    // the account key's signature, and drops the warning by itself — the user
    // is never asked to compare a second number.
    const bAfterApproval = `B replies once the device is approved ${Date.now()}`;
    await sendMessage(pageB, bAfterApproval);
    await expect(page.getByText(bAfterApproval).first()).toBeVisible({ timeout: 20_000 });
    await expect(pageB.locator(BADGE_UNSIGNED)).toHaveCount(0, { timeout: 20_000 });
    await expect(pageB.locator(BADGE)).toBeVisible({ timeout: 20_000 });

    // A's own badge settles too — an approved device is no longer a warning
    await expect(page.locator(BADGE)).toBeVisible({ timeout: 20_000 });

    // ── Revoke device 2 from device 1 ──
    await page.locator(BADGE).click();
    await page.locator('button[title="Manage devices"]').click();
    await expect(page.getByText('Your devices')).toBeVisible({ timeout: 10_000 });
    await page.locator('button[title="Revoke"]').first().click();
    await page.getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect
      .poll(async () => (await getE2EDevices(dataA.user.id)).length, { timeout: 20_000 })
      .toBe(1);
    expect((await getE2EDevices(dataA.user.id))[0].deviceId).not.toBe(secondDeviceId);
    // pending shares for the revoked device are dropped with it
    expect(await getE2EKeyShareCount(dataA.user.id, secondDeviceId)).toBe(0);
    // the device manager sits above the safety modal (z-[60]); close both
    await page.getByRole('button', { name: 'Close' }).last().click();
    await closeModal(page);

    // ── Post-revocation traffic must NOT reach the revoked device ──
    await expect(page.locator(BADGE)).toBeVisible({ timeout: 20_000 });

    const afterRevoke = `only for the remaining device ${Date.now()}`;
    await sendMessage(page, afterRevoke);
    await expect(pageB.getByText(afterRevoke).first()).toBeVisible({ timeout: 20_000 });
    // the revoked client is still open; it must never render this plaintext
    await expect(pageA2.getByText(afterRevoke)).toHaveCount(0);
    expect(await getE2EKeyShareCount(dataA.user.id, secondDeviceId)).toBe(0);

    await contextA2.close();
    await contextB.close();
  });
});
