import { test, expect } from './helpers/fixtures';
import { testUser, registerViaUI, injectAuth } from './helpers/auth';
import { registerUser, createInvite } from './helpers/api';
import { dmHeading } from './helpers/selectors';

test.describe('Critical path: register -> create server -> invite -> message', () => {
  test('full flow', async ({ page, request, browser }) => {
    // === Step 1: Register user A via UI ===
    const userA = testUser('alice');
    await registerViaUI(page, userA);
    await expect(dmHeading(page)).toBeVisible({ timeout: 10_000 });

    // === Step 2: Create a server ===
    await page.locator('button:has(svg.lucide-plus)').click();
    await expect(page.getByText('Create a Server')).toBeVisible();

    const serverName = `TestServer-${Date.now()}`;
    await page.getByPlaceholder('My Awesome Server').fill(serverName);
    await page.getByRole('button', { name: 'Create Server' }).click();

    // Wait for the server to be active — channel sidebar should show #general
    await expect(page.getByText('general').first()).toBeVisible({ timeout: 10_000 });

    // === Step 3: Send a message in #general ===
    await page.getByText('general').first().click();

    const messageContent = `Hello from E2E test! ${Date.now()}`;
    await page.locator('textarea').fill(messageContent);
    await page.keyboard.press('Enter');
    await expect(page.locator(`text=${messageContent}`)).toBeVisible({ timeout: 10_000 });

    // === Step 4: Create an invite via API ===
    const tokenA = await page.evaluate(() => localStorage.getItem('voxium_access_token'));
    expect(tokenA).toBeTruthy();

    const serversRes = await request.get('http://localhost:3001/api/v1/servers', {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    const { data: servers } = await serversRes.json();
    const server = servers.find((s: any) => s.name === serverName);
    expect(server).toBeTruthy();
    const inviteCode = await createInvite(request, tokenA!, server.id);

    // === Step 5: Register user B and join via invite ===
    const userB = testUser('bob');
    const userBData = await registerUser(request, userB);

    const context2 = await browser.newContext();
    const page2 = await context2.newPage();
    await injectAuth(page2, userBData);

    await page2.goto(`/invite/${inviteCode}`);
    await page2.getByRole('button', { name: /join/i }).click({ timeout: 10_000 });

    // Wait for the server view
    await expect(page2.getByText(serverName)).toBeVisible({ timeout: 10_000 });

    // User B should see A's message in #general
    await page2.getByText('general').first().click();
    await expect(page2.locator(`text=${messageContent}`)).toBeVisible({ timeout: 10_000 });

    // === Step 6: User B sends a reply ===
    const replyContent = `Reply from user B! ${Date.now()}`;
    await page2.locator('textarea').fill(replyContent);
    await page2.keyboard.press('Enter');
    await expect(page2.locator(`text=${replyContent}`)).toBeVisible({ timeout: 10_000 });

    // User A should see the reply in real-time
    await expect(page.locator(`text=${replyContent}`)).toBeVisible({ timeout: 10_000 });

    await context2.close();
  });
});
