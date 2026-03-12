import { test, expect } from './helpers/fixtures';
import { testUser, injectAuth } from './helpers/auth';
import { registerUser, createServer, createInvite, joinServerViaInvite, getServerChannels, API_URL } from './helpers/api';

test.describe('@mention system', () => {
  test('user can mention another user and it renders as a styled mention', async ({ page, request, browser }) => {
    // Register two users via API
    const userA = testUser('mentionA');
    const userB = testUser('mentionB');
    const dataA = await registerUser(request, userA);
    const dataB = await registerUser(request, userB);

    // User A creates a server
    const server = await createServer(request, dataA.accessToken, `MentionTest-${Date.now()}`);
    const invite = await createInvite(request, dataA.accessToken, server.id);

    // User B joins the server
    await joinServerViaInvite(request, dataB.accessToken, invite);

    // Get the general channel
    const channels = await getServerChannels(request, dataA.accessToken, server.id);
    const generalChannel = channels.find((c) => c.name === 'general');
    expect(generalChannel).toBeTruthy();

    // User A opens the app and navigates to the server
    await injectAuth(page, dataA);
    await page.locator(`[title="${server.name}"]`).click({ timeout: 10_000 });
    await expect(page.getByText('general').first()).toBeVisible({ timeout: 10_000 });
    await page.getByText('general').first().click();

    // Wait for textarea to be ready
    await expect(page.locator('textarea')).toBeVisible({ timeout: 5_000 });

    // User A sends a message mentioning User B using the @[userId] format
    const mentionContent = `Hey @[${dataB.user.id}] check this out!`;
    await page.locator('textarea').fill(mentionContent);
    await page.keyboard.press('Enter');

    // Verify the mention renders as a styled badge (not raw @[userId])
    await expect(page.locator('[data-testid="mention-badge"]').first()).toBeVisible({ timeout: 10_000 });
    // The badge should show User B's display name
    await expect(page.locator('[data-testid="mention-badge"]').first()).toContainText(userB.username);

    // Verify the raw @[userId] is NOT visible in the rendered message
    await expect(page.locator(`text=@[${dataB.user.id}]`)).not.toBeVisible();

    // User B opens the app in a new context and sees the mention
    const context2 = await browser.newContext();
    const page2 = await context2.newPage();
    await injectAuth(page2, dataB);
    await page2.locator(`[title="${server.name}"]`).click({ timeout: 10_000 });
    await expect(page2.getByText('general').first()).toBeVisible({ timeout: 10_000 });
    await page2.getByText('general').first().click();

    // User B should see the mention badge
    await expect(page2.locator('[data-testid="mention-badge"]').first()).toBeVisible({ timeout: 10_000 });
    await expect(page2.locator('[data-testid="mention-badge"]').first()).toContainText(userB.username);

    // User B's message should be highlighted (border-l-2 indicator)
    const messageRow = page2.locator('[data-testid="mention-badge"]').first().locator('xpath=ancestor::div[@data-message-id]');
    await expect(messageRow).toHaveClass(/border-vox-accent-primary/);

    await context2.close();
  });

  test('mention autocomplete appears when typing @ in server channel', async ({ page, request, browser }) => {
    const userA = testUser('autoA');
    const userB = testUser('autoB');
    const dataA = await registerUser(request, userA);
    const dataB = await registerUser(request, userB);

    const server = await createServer(request, dataA.accessToken, `AutoTest-${Date.now()}`);
    const invite = await createInvite(request, dataA.accessToken, server.id);
    await joinServerViaInvite(request, dataB.accessToken, invite);

    await injectAuth(page, dataA);
    await page.locator(`[title="${server.name}"]`).click({ timeout: 10_000 });
    await expect(page.getByText('general').first()).toBeVisible({ timeout: 10_000 });
    await page.getByText('general').first().click();
    await expect(page.locator('textarea')).toBeVisible({ timeout: 5_000 });

    // Type @ followed by part of user B's username to trigger + filter autocomplete
    await page.locator('textarea').fill(`@${userB.username.slice(0, 5)}`);

    // Autocomplete should appear
    await expect(page.locator('[data-testid="mention-autocomplete"]')).toBeVisible({ timeout: 5_000 });

    // Click on user B in the autocomplete
    const autocompleteItem = page.locator('[data-testid="mention-autocomplete"] button').first();
    await expect(autocompleteItem).toBeVisible();
    await autocompleteItem.click();

    // Textarea should now contain the @[userId] format
    const value = await page.locator('textarea').inputValue();
    expect(value).toContain(`@[${dataB.user.id}]`);
  });

  test('mention in message sent via API is resolved correctly', async ({ page, request }) => {
    const userA = testUser('apiA');
    const userB = testUser('apiB');
    const dataA = await registerUser(request, userA);
    const dataB = await registerUser(request, userB);

    const server = await createServer(request, dataA.accessToken, `ApiTest-${Date.now()}`);
    const invite = await createInvite(request, dataA.accessToken, server.id);
    await joinServerViaInvite(request, dataB.accessToken, invite);

    const channels = await getServerChannels(request, dataA.accessToken, server.id);
    const general = channels.find((c) => c.name === 'general')!;

    // Send a message with mention via API
    const content = `Hello @[${dataB.user.id}] welcome!`;
    const res = await request.post(`${API_URL}/channels/${general.id}/messages`, {
      data: { content },
      headers: { Authorization: `Bearer ${dataA.accessToken}` },
    });
    expect(res.ok()).toBeTruthy();
    const { data } = await res.json();

    // Response should include resolved mentions
    expect(data.mentions).toBeDefined();
    expect(data.mentions.length).toBe(1);
    expect(data.mentions[0].id).toBe(dataB.user.id);
    expect(data.mentions[0].username).toBe(userB.username);
  });

  test('mention of non-member is not resolved', async ({ request }) => {
    const userA = testUser('nonmA');
    const userB = testUser('nonmB');
    const dataA = await registerUser(request, userA);
    const dataB = await registerUser(request, userB);

    // Only user A creates and is in the server; user B is NOT a member
    const server = await createServer(request, dataA.accessToken, `NonMem-${Date.now()}`);
    const channels = await getServerChannels(request, dataA.accessToken, server.id);
    const general = channels.find((c) => c.name === 'general')!;

    // Mention user B who is not a server member
    const content = `Hey @[${dataB.user.id}] are you here?`;
    const res = await request.post(`${API_URL}/channels/${general.id}/messages`, {
      data: { content },
      headers: { Authorization: `Bearer ${dataA.accessToken}` },
    });
    expect(res.ok()).toBeTruthy();
    const { data } = await res.json();

    // Mention should not resolve since user B is not a member
    expect(data.mentions).toBeDefined();
    expect(data.mentions.length).toBe(0);
  });
});
