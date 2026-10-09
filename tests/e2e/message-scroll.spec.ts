import { test, expect } from './helpers/fixtures';
import { testUser, injectAuth } from './helpers/auth';
import { registerUser, createServer, createInvite, joinServerViaInvite, getServerChannels, clearRateLimits, API_URL } from './helpers/api';

/**
 * Scroll contract when a message arrives with the panel full:
 *  - YOUR message always snaps the list to the bottom, even if the view had
 *    drifted slightly above Virtuoso's at-bottom threshold (the regression:
 *    followOutput never fired there, hiding the message you just sent).
 *  - OTHERS' messages never move your reading position.
 */

async function fillChannel(request: Parameters<typeof registerUser>[0], token: string, channelId: string, count: number) {
  for (let i = 0; i < count; i++) {
    const res = await request.post(`${API_URL}/channels/${channelId}/messages`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { content: `filler message ${i} — enough text to give each row some height in the list` },
    });
    expect(res.ok()).toBeTruthy();
  }
}

test.describe('chat scroll behavior', () => {
  test('sending your own message snaps the list to the bottom', async ({ page, request }) => {
    const userA = testUser('scrollA');
    const dataA = await registerUser(request, userA);
    const server = await createServer(request, dataA.accessToken, `ScrollSnap-${Date.now()}`);
    const channels = await getServerChannels(request, dataA.accessToken, server.id);
    const general = channels.find((c) => c.name === 'general')!;
    await fillChannel(request, dataA.accessToken, general.id, 30);
    // The filler burst above consumed this user's message rate budget — the
    // UI send below must not fail on it.
    await clearRateLimits();

    await injectAuth(page, dataA);
    await page.getByRole('button', { name: server.name, exact: true }).click({ timeout: 10_000 });
    await page.getByText('general').first().click();
    await expect(page.locator('[data-message-id]').first()).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(500);

    // Drift a bit above the bottom — inside the dead zone where followOutput
    // no longer fires but a user still perceives themselves "at the bottom".
    const scroller = page.locator('[data-virtuoso-scroller]');
    await scroller.evaluate((el) => { el.scrollTop -= 150; });
    await page.waitForTimeout(300);

    await page.locator('textarea').fill('my own message must land in view');
    await page.keyboard.press('Enter');

    await expect(page.getByText('my own message must land in view')).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(600);

    const atBottom = await scroller.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 5);
    expect(atBottom, 'list snapped to the bottom after own send').toBeTruthy();
    const rowBox = (await page.locator('[data-message-id]').last().boundingBox())!;
    const scrollerBox = (await scroller.boundingBox())!;
    expect(rowBox.y + rowBox.height, 'sent message fully inside the viewport')
      .toBeLessThanOrEqual(scrollerBox.y + scrollerBox.height + 2);
  });

  test("messages from others don't move your reading position", async ({ page, request }) => {
    const userA = testUser('scrollB');
    const userB = testUser('scrollC');
    const dataA = await registerUser(request, userA);
    const dataB = await registerUser(request, userB);
    const server = await createServer(request, dataA.accessToken, `ScrollKeep-${Date.now()}`);
    const invite = await createInvite(request, dataA.accessToken, server.id);
    await joinServerViaInvite(request, dataB.accessToken, invite);
    const channels = await getServerChannels(request, dataA.accessToken, server.id);
    const general = channels.find((c) => c.name === 'general')!;
    await fillChannel(request, dataA.accessToken, general.id, 30);

    await injectAuth(page, dataA);
    await page.getByRole('button', { name: server.name, exact: true }).click({ timeout: 10_000 });
    await page.getByText('general').first().click();
    await expect(page.locator('[data-message-id]').first()).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(500);

    // Scroll well up into history — a genuine reading position.
    const scroller = page.locator('[data-virtuoso-scroller]');
    await scroller.evaluate((el) => { el.scrollTop -= 600; });
    await page.waitForTimeout(300);
    const before = await scroller.evaluate((el) => ({ top: el.scrollTop, height: el.scrollHeight }));

    // B posts; it arrives over the socket and grows the list.
    const res = await request.post(`${API_URL}/channels/${general.id}/messages`, {
      headers: { Authorization: `Bearer ${dataB.accessToken}` },
      data: { content: 'incoming message from someone else' },
    });
    expect(res.ok()).toBeTruthy();
    await expect
      .poll(() => scroller.evaluate((el) => el.scrollHeight), { timeout: 10_000 })
      .toBeGreaterThan(before.height);
    await page.waitForTimeout(500);

    const after = await scroller.evaluate((el) => ({
      top: el.scrollTop,
      atBottom: el.scrollHeight - el.scrollTop - el.clientHeight < 5,
    }));
    expect(Math.abs(after.top - before.top), 'reading position unchanged').toBeLessThanOrEqual(5);
    expect(after.atBottom, 'must NOT have been dragged to the bottom').toBeFalsy();
  });
});
