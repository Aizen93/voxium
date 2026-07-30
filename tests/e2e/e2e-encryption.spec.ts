import type { Page } from '@playwright/test';
import { test, expect } from './helpers/fixtures';
import { testUser, injectAuth } from './helpers/auth';
import { registerUser, sendFriendRequest, acceptFriendRequest, API_URL } from './helpers/api';
import { getConversationServerState } from './helpers/db';

// Live two-client smoke test of the full E2E DM flow (docs/e2e-dm-spec.md):
// enable + badge, cross-client encrypt/decrypt, matching safety numbers,
// encrypted edits, encrypted attachments — finishing with DB-level proof
// that the server only ever stored ciphertext and opaque blobs.

// 1x1 red PNG
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

/** The 60-digit safety number shown in the modal, as one string. */
async function readSafetyNumber(page: Page): Promise<string> {
  await page.locator('button[title="End-to-end encrypted — view safety number"]').click();
  const groups = page.locator('div.select-all span');
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
    await page.getByRole('button', { name: 'Mark as verified' }).click();
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
});
