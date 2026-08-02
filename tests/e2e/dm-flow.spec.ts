import { test, expect } from './helpers/fixtures';
import { testUser, injectAuth } from './helpers/auth';
import { registerUser, sendFriendRequest, acceptFriendRequest } from './helpers/api';
import { dmHeading } from './helpers/selectors';

test.describe('DM flow: friend request -> accept -> message', () => {
  test('send friend request, accept, and exchange DMs', async ({ page, request, browser }) => {
    // === Setup: Create two users via API ===
    const userA = testUser('dma');
    const userB = testUser('dmb');
    const dataA = await registerUser(request, userA);
    const dataB = await registerUser(request, userB);

    // User A sends friend request to User B
    await sendFriendRequest(request, dataA.accessToken, userB.username);
    // User B accepts
    await acceptFriendRequest(request, dataB.accessToken, dataA.user.id);

    // === User A: Open browser, navigate to DMs ===
    await injectAuth(page, dataA);
    await expect(dmHeading(page)).toBeVisible({ timeout: 10_000 });

    // Click Friends tab, then "All" to see all friends (not just online)
    await page.getByText('Friends').first().click();
    await page.getByText('All').click();
    await expect(page.getByText(userB.username, { exact: true }).first()).toBeVisible({ timeout: 10_000 });

    // Click the Message button next to user B to start a DM
    await page.locator('button[title="Message"]').first().click();

    // Wait for DM chat area — look for the textarea
    await expect(page.locator('textarea')).toBeVisible({ timeout: 10_000 });

    // === User B: Open in second browser context ===
    // Before A can send, not after. Every DM is encrypted now, so a recipient
    // who has never opened the app has published no device to encrypt to —
    // there is nowhere for the message to go, and the client says so rather
    // than pretending it sent. Opening B's client first is what registers it.
    const context2 = await browser.newContext();
    const page2 = await context2.newPage();
    await injectAuth(page2, dataB);
    await expect(page2.getByRole('heading', { name: 'Direct Messages' }).first()).toBeVisible({ timeout: 20_000 });

    // Send a message
    const msgA = `Hey from A! ${Date.now()}`;
    await page.locator('textarea').fill(msgA);
    await page.keyboard.press('Enter');
    await expect(page.locator('.leading-relaxed', { hasText: msgA })).toBeVisible({ timeout: 15_000 });

    // User B should see the DM conversation in the sidebar
    await expect(page2.getByText(userA.username, { exact: true }).first()).toBeVisible({ timeout: 15_000 });
    await page2.getByText(userA.username, { exact: true }).first().click();

    // User B should see User A's message
    await expect(page2.locator('.leading-relaxed', { hasText: msgA })).toBeVisible({ timeout: 10_000 });

    // User B replies
    const msgB = `Reply from B! ${Date.now()}`;
    await page2.locator('textarea').fill(msgB);
    await page2.keyboard.press('Enter');
    await expect(page2.locator('.leading-relaxed', { hasText: msgB })).toBeVisible({ timeout: 10_000 });

    // User A should see the reply in real-time
    await expect(page.locator('.leading-relaxed', { hasText: msgB })).toBeVisible({ timeout: 10_000 });

    // ── Hiding the window and coming back must not report a false failure ──
    // Reported from the running app, on both the Tauri client and the browser.
    // Becoming visible re-fetches the DM list and hydrates each encrypted
    // preview from the local vault; that hydration used to run under the same
    // catch as the fetch, so any local-cache problem — routinely, an IndexedDB
    // connection the browser closed while the page was hidden — surfaced as
    // "Failed to load conversations" over a list that was already on screen.
    //
    // Asserted here rather than in a fresh-account test because it needs what
    // this test has built: a conversation with real encrypted messages, so the
    // preview path actually runs.
    const consoleErrors: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text());
    });

    // Twice: the symptom recurred on every hide/restore, so once would not
    // catch a recovery that only works the first time.
    for (let i = 0; i < 2; i++) {
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await page.waitForTimeout(700);
    }

    await expect(page.getByText('Failed to load conversations')).toHaveCount(0);
    expect(consoleErrors.filter((e) => /Failed to fetch conversations/.test(e))).toEqual([]);
    // still usable, and the history is still there
    await expect(page.locator('.leading-relaxed', { hasText: msgB })).toBeVisible();

    await context2.close();
  });

});
