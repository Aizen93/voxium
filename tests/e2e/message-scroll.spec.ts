import { test, expect } from './helpers/fixtures';
import { testUser, injectAuth } from './helpers/auth';
import { registerUser, createServer, createInvite, joinServerViaInvite, getServerChannels, clearRateLimits, API_URL } from './helpers/api';
import { untilSettled, untilSettledAtBottom, watchScrollTop } from './helpers/scroll';

/**
 * Scroll contract when a message arrives with the panel full:
 *  - YOUR message always snaps the list to the bottom, even if the view had
 *    drifted slightly above Virtuoso's at-bottom threshold (the regression:
 *    followOutput never fired there, hiding the message you just sent).
 *  - OTHERS' messages never move your reading position.
 *
 * No fixed sleeps: each step waits until the list has come to REST in the
 * state it needs (helpers/scroll.ts), so a slow machine waits longer instead
 * of measuring a list that is still moving.
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
    const scroller = page.locator('[data-virtuoso-scroller]');
    const jumpButton = page.getByRole('button', { name: 'Jump to bottom' });
    // The channel opens at the bottom. Drift only once the list rests there:
    // a positioning pass still to come would undo the drift.
    await untilSettledAtBottom(scroller, 'channel opened');
    await expect(jumpButton).toBeHidden();

    // Drift a bit above the bottom — inside the dead zone where followOutput
    // no longer fires but a user still perceives themselves "at the bottom".
    await scroller.evaluate((el) => { el.scrollTop -= 150; });
    // Virtuoso shows its jump button exactly when it reports not-at-bottom
    // (threshold 100 px), the state in which followOutput stays put: the send
    // below must snap the list down from there, and the drift must have held.
    await expect(jumpButton).toBeVisible();
    await untilSettled(scroller, 'drifted above the bottom', (s) => s.gap > 100);

    await page.locator('textarea').fill('my own message must land in view');
    await page.keyboard.press('Enter');

    await expect(page.getByText('my own message must land in view')).toBeVisible({ timeout: 10_000 });
    // Where the list comes to rest, not a moment on its way: one that reached
    // the bottom and crept back up fails here
    await untilSettledAtBottom(scroller, 'list snapped to the bottom after own send', 4);
    const rowBox = (await page.locator('[data-message-id]').last().boundingBox())!;
    const scrollerBox = (await scroller.boundingBox())!;
    expect(rowBox.y + rowBox.height, 'sent message fully inside the viewport')
      .toBeLessThanOrEqual(scrollerBox.y + scrollerBox.height + 2);
  });

  test('in a conversation between two people, every new message lands fully in view', async ({ page, request }) => {
    // Alternating authors: every row starts an author group, so every row
    // carries MessageItem's group margin. The test above fills from one author
    // and never sees it. The regression: those margins collapsed out of the
    // rows Virtuoso measures, so its follow-to-bottom stopped short by their
    // sum and both your message and an incoming one sat below the fold.
    const userA = testUser('scrollD');
    const userB = testUser('scrollE');
    const dataA = await registerUser(request, userA);
    const dataB = await registerUser(request, userB);
    const server = await createServer(request, dataA.accessToken, `ScrollTalk-${Date.now()}`);
    const invite = await createInvite(request, dataA.accessToken, server.id);
    await joinServerViaInvite(request, dataB.accessToken, invite);
    const channels = await getServerChannels(request, dataA.accessToken, server.id);
    const general = channels.find((c) => c.name === 'general')!;
    for (let i = 0; i < 24; i++) {
      const res = await request.post(`${API_URL}/channels/${general.id}/messages`, {
        headers: { Authorization: `Bearer ${(i % 2 ? dataB : dataA).accessToken}` },
        data: { content: `turn ${i}: a line of conversation with some length to it` },
      });
      expect(res.ok()).toBeTruthy();
    }
    await clearRateLimits();

    await injectAuth(page, dataA);
    await page.getByRole('button', { name: server.name, exact: true }).click({ timeout: 10_000 });
    await page.getByText('general').first().click();
    await expect(page.locator('[data-message-id]').first()).toBeVisible({ timeout: 10_000 });
    const scroller = page.locator('[data-virtuoso-scroller]');
    await untilSettledAtBottom(scroller, 'channel opened');

    const expectNewestFullyVisible = async (label: string) => {
      // Where the list comes to rest, not how fast: the config's expect budget applies.
      await untilSettledAtBottom(scroller, label);
      const rowBox = (await page.locator('[data-message-id]').last().boundingBox())!;
      const scrollerBox = (await scroller.boundingBox())!;
      expect(rowBox.y + rowBox.height, `${label}: newest message fully inside the viewport`)
        .toBeLessThanOrEqual(scrollerBox.y + scrollerBox.height + 2);
    };

    await page.locator('textarea').fill('my reply must land in view');
    await page.keyboard.press('Enter');
    await expect(page.getByText('my reply must land in view')).toBeVisible({ timeout: 10_000 });
    await expectNewestFullyVisible('own message');

    const res = await request.post(`${API_URL}/channels/${general.id}/messages`, {
      headers: { Authorization: `Bearer ${dataB.accessToken}` },
      data: { content: 'their answer must land in view too' },
    });
    expect(res.ok()).toBeTruthy();
    await expect(page.getByText('their answer must land in view too')).toBeVisible({ timeout: 10_000 });
    await expectNewestFullyVisible('incoming message');
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
    const scroller = page.locator('[data-virtuoso-scroller]');
    await untilSettledAtBottom(scroller, 'channel opened');

    // Scroll well up into history — a genuine reading position.
    await scroller.evaluate((el) => { el.scrollTop -= 600; });
    // Virtuoso reports not-at-bottom (its jump button), and the position
    // rests: only then is it the reading position the message must not move
    await expect(page.getByRole('button', { name: 'Jump to bottom' })).toBeVisible();
    const rest = await untilSettled(scroller, 'scrolled up into history', (s) => s.gap > 100);
    const before = { top: rest.scrollTop, height: rest.scrollHeight };

    // B posts; it arrives over the socket and grows the list.
    const res = await request.post(`${API_URL}/channels/${general.id}/messages`, {
      headers: { Authorization: `Bearer ${dataB.accessToken}` },
      data: { content: 'incoming message from someone else' },
    });
    expect(res.ok()).toBeTruthy();
    await expect
      .poll(() => scroller.evaluate((el) => el.scrollHeight), { timeout: 10_000 })
      .toBeGreaterThan(before.height);

    // The list has taken the message in. What must not follow (a drag to the
    // bottom) has no event to wait for, so this is a measured time window:
    // scrollTop is read on each of 30 frames (about half a second at 60 Hz,
    // longer on a slower machine) and every reading must be the position.
    const watched = await watchScrollTop(scroller, 30);
    expect(watched.max - before.top, 'reading position unchanged (never moved down)').toBeLessThanOrEqual(5);
    expect(before.top - watched.min, 'reading position unchanged (never moved up)').toBeLessThanOrEqual(5);
    expect(watched.gap, 'must NOT have been dragged to the bottom').toBeGreaterThanOrEqual(5);
  });
});
