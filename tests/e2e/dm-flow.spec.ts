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

    // Send a message
    const msgA = `Hey from A! ${Date.now()}`;
    await page.locator('textarea').fill(msgA);
    await page.keyboard.press('Enter');
    await expect(page.locator('.leading-relaxed', { hasText: msgA })).toBeVisible({ timeout: 10_000 });

    // === User B: Open in second browser context ===
    const context2 = await browser.newContext();
    const page2 = await context2.newPage();
    await injectAuth(page2, dataB);

    // User B should see the DM conversation in the sidebar
    await expect(page2.getByText(userA.username, { exact: true }).first()).toBeVisible({ timeout: 10_000 });
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

    await context2.close();
  });
});
