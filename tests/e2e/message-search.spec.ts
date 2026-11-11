import { test, expect } from './helpers/fixtures';
import { testUser, injectAuth } from './helpers/auth';
import { registerUser, createServer, createChannel, getServerChannels, sendFriendRequest, acceptFriendRequest, clearRateLimits, API_URL } from './helpers/api';
import { untilRowRestsInView, untilSettledAtBottom } from './helpers/scroll';

/**
 * A jump to a search result re-applies its scroll for 350 ms after the row
 * mounts (MessageList: the remounted list positions itself asynchronously, so
 * the jump retries at 120 and 350 ms). Thirty frames at rest, about half a
 * second at 60 Hz, span those retries: a row that is only passing through the
 * viewport on its way somewhere else does not count as landed.
 */
const JUMP_REST_FRAMES = 30;

/**
 * Search must actually take you to the message.
 *
 * Clicking a result runs an "around" fetch that REPLACES the loaded window
 * mid-channel. The regression this pins: the list's append/prepend
 * bookkeeping couldn't describe a replace, so the jump landed nowhere (or on
 * the wrong row) and the target highlight never fired. The fix remounts the
 * virtualized list onto the target row.
 *
 * Also pinned: inside a jumped-to history window, the scroll-to-bottom
 * button must return to NOW (refetch the live tail) — the newest messages
 * aren't in the window, so merely scrolling would strand the user in history.
 */
test.describe('message search jump', () => {
  test('clicking a search result lands on and highlights that message', async ({ page, request }) => {
    const userA = testUser('search');
    const dataA = await registerUser(request, userA);
    const server = await createServer(request, dataA.accessToken, `SearchJump-${Date.now()}`);
    const channels = await getServerChannels(request, dataA.accessToken, server.id);
    const general = channels.find((c) => c.name === 'general')!;

    // 60 messages so the needle (posted 5th) is well outside the latest page.
    const needle = 'quasar-needle-alpha';
    for (let i = 0; i < 60; i++) {
      if (i > 0 && i % 25 === 0) await clearRateLimits(); // stay under 30/min
      const content = i === 4 ? `the ${needle} hides here` : `haystack message ${i} with enough words to look real`;
      const res = await request.post(`${API_URL}/channels/${general.id}/messages`, {
        headers: { Authorization: `Bearer ${dataA.accessToken}` },
        data: { content },
      });
      expect(res.ok()).toBeTruthy();
    }
    await clearRateLimits();

    await injectAuth(page, dataA);
    await page.getByRole('button', { name: server.name, exact: true }).click({ timeout: 10_000 });
    await page.getByText('general', { exact: true }).first().click();
    await expect(page.locator('[data-message-id]').first()).toBeVisible({ timeout: 10_000 });
    // The latest page is the one loaded and the list rests at its bottom
    await expect(page.getByText('haystack message 59', { exact: false }).first()).toBeVisible();
    const scroller = page.locator('[data-virtuoso-scroller]');
    await untilSettledAtBottom(scroller, 'channel opened');

    // The needle is NOT in the loaded page.
    await expect(page.getByText(needle)).not.toBeVisible();

    // Search and jump.
    await page.keyboard.press('Control+k');
    await page.getByPlaceholder(/search/i).fill(needle);
    const result = page.getByText(`the ${needle} hides here`).first();
    await expect(result).toBeVisible({ timeout: 10_000 });
    await result.click();

    // The window replace must not crash the chat panel into its error
    // boundary — that was the reported "search is broken".
    await expect(page.getByText('This section encountered an error')).not.toBeVisible();

    // The target message is on screen, inside the scroller viewport, and
    // stays there once the jump has stopped re-applying itself.
    const target = page.locator(`[data-message-id]`, { hasText: needle }).first();
    await expect(target).toBeVisible({ timeout: 10_000 });
    const targetId = (await target.getAttribute('data-message-id'))!;
    await untilRowRestsInView(scroller, targetId, 'search jump', JUMP_REST_FRAMES);
    const box = (await target.boundingBox())!;
    const sBox = (await scroller.boundingBox())!;
    expect(box.y, 'target above the fold').toBeGreaterThanOrEqual(sBox.y - 2);
    expect(box.y + box.height, 'target below the fold').toBeLessThanOrEqual(sBox.y + sBox.height + 2);

    // Neighbours around the needle are loaded — this is the around-window.
    await expect(page.getByText('haystack message 3', { exact: false }).first()).toBeVisible();

    // Back to NOW: the button must reload the live tail, where the newest
    // message exists — not just scroll to the window's edge.
    await page.getByRole('button', { name: 'Jump to bottom' }).click();
    await expect(page.getByText('haystack message 59', { exact: false }).first()).toBeVisible({ timeout: 10_000 });
  });

  test('a result in ANOTHER channel switches channels and lands on the message', async ({ page, request }) => {
    const userA = testUser('xchan');
    const dataA = await registerUser(request, userA);
    const server = await createServer(request, dataA.accessToken, `CrossChan-${Date.now()}`);
    const channels = await getServerChannels(request, dataA.accessToken, server.id);
    const general = channels.find((c) => c.name === 'general')!;
    const archive = await createChannel(request, dataA.accessToken, server.id, 'archive', 'text');

    const needle = 'nebula-needle-beta';
    for (let i = 0; i < 8; i++) {
      const res = await request.post(`${API_URL}/channels/${general.id}/messages`, {
        headers: { Authorization: `Bearer ${dataA.accessToken}` },
        data: { content: `general chatter ${i}` },
      });
      expect(res.ok()).toBeTruthy();
    }
    await clearRateLimits();
    for (let i = 0; i < 60; i++) {
      if (i > 0 && i % 25 === 0) await clearRateLimits();
      const content = i === 4 ? `the ${needle} hides here` : `archive haystack ${i} with enough words`;
      const res = await request.post(`${API_URL}/channels/${archive.id}/messages`, {
        headers: { Authorization: `Bearer ${dataA.accessToken}` },
        data: { content },
      });
      expect(res.ok()).toBeTruthy();
    }
    await clearRateLimits();

    // Viewing GENERAL; the needle lives deep inside ARCHIVE.
    await injectAuth(page, dataA);
    await page.getByRole('button', { name: server.name, exact: true }).click({ timeout: 10_000 });
    await page.getByText('general', { exact: true }).first().click();
    await expect(page.getByText('general chatter 7').first()).toBeVisible({ timeout: 10_000 });

    await page.keyboard.press('Control+k');
    await page.getByPlaceholder(/search/i).fill(needle);
    const result = page.getByText(`the ${needle} hides here`).first();
    await expect(result).toBeVisible({ timeout: 10_000 });
    await result.click();

    await expect(page.getByText('This section encountered an error')).not.toBeVisible();
    const target = page.locator(`[data-message-id]`, { hasText: needle }).first();
    await expect(target).toBeVisible({ timeout: 10_000 });
    const scroller = page.locator('[data-virtuoso-scroller]');
    const targetId = (await target.getAttribute('data-message-id'))!;
    await untilRowRestsInView(scroller, targetId, 'cross-channel jump', JUMP_REST_FRAMES);
    const box = (await target.boundingBox())!;
    const sBox = (await scroller.boundingBox())!;
    expect(box.y, 'target above the fold').toBeGreaterThanOrEqual(sBox.y - 2);
    expect(box.y + box.height, 'target below the fold').toBeLessThanOrEqual(sBox.y + sBox.height + 2);
    // We really are in the archive window, not still in general.
    await expect(page.getByText('archive haystack 3').first()).toBeVisible();
  });

  test('a DM search result jumps without "Failed to load messages"', async ({ page, request, browser }) => {
    const userA = testUser('dmsA');
    const userB = testUser('dmsB');
    const dataA = await registerUser(request, userA);
    const dataB = await registerUser(request, userB);
    await sendFriendRequest(request, dataA.accessToken, userB.username);
    await acceptFriendRequest(request, dataB.accessToken, dataA.user.id);

    await injectAuth(page, dataA);
    await page.getByText('Friends').first().click();
    await page.getByRole('button', { name: 'All', exact: true }).click();
    await expect(page.getByText(userB.username, { exact: true }).first()).toBeVisible({ timeout: 10_000 });
    await page.locator('button[title="Message"]').first().click();
    await expect(page.locator('textarea')).toBeVisible({ timeout: 10_000 });

    // B's device must exist before A can encrypt to it.
    const context2 = await browser.newContext();
    const page2 = await context2.newPage();
    await injectAuth(page2, dataB);
    await expect(page2.getByRole('heading', { name: 'Direct Messages' }).first()).toBeVisible({ timeout: 20_000 });

    const netErrors: string[] = [];
    page.on('response', (r) => {
      if (r.status() >= 400) netErrors.push(`${r.status()} ${r.request().method()} ${r.url().slice(-60)}`);
    });
    const consoleLog: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') consoleLog.push(m.text().slice(0, 200));
    });

    // B's page loading is not B's device being published (engine init, vault,
    // key upload come after): wait on the server's own device list before A
    // encrypts to it, as dm-flow does.
    await expect
      .poll(async () => {
        const res = await request.get(`${API_URL}/e2e/devices/${dataB.user.id}`, {
          headers: { Authorization: `Bearer ${dataA.accessToken}` },
        });
        if (!res.ok()) return 0;
        const body = (await res.json()) as { data?: { devices?: unknown[] } };
        return body.data?.devices?.length ?? 0;
      }, { timeout: 30_000, message: "user B's E2E device was never published" })
      .toBeGreaterThan(0);

    const needle = 'pulsar-needle-gamma';
    for (let i = 0; i < 10; i++) {
      const content = i === 1 ? `the ${needle} hides here` : `dm filler line ${i} some words`;
      await page.locator('textarea').fill(content);
      await page.keyboard.press('Enter');
      // The row itself, not the composer or the sidebar preview.
      const row = page.locator(`[data-message-id]`, { hasText: content }).first();
      try {
        await expect(row).toBeVisible({ timeout: 8000 });
      } catch {
        // A very early send can lose the race with the peer's device
        // registration; the composer keeps the text on failure, so retry.
        // (If the send DID land, the composer is empty and this is a no-op.)
        await page.keyboard.press('Enter');
        await expect(row).toBeVisible({ timeout: 15_000 });
      }
    }
    console.log('NET:', netErrors.slice(0, 6).join(' | '));
    console.log('CONSOLE:', consoleLog.slice(0, 4).join(' || '));

    const consoleErrors: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') consoleErrors.push(`${m.type()}: ${m.text()}`);
    });

    // Bisect: are the sent messages still on screen before the search opens?
    // The first and the last of them, rendered after every send has landed
    await expect(page.locator('[data-message-id]', { hasText: `the ${needle} hides here` }).first()).toBeVisible();
    await expect(page.locator('[data-message-id]', { hasText: 'dm filler line 9 some words' }).first()).toBeVisible();
    const visibleRows = await page.locator('[data-message-id]').count();
    console.log('ROWS BEFORE SEARCH:', visibleRows);

    await page.keyboard.press('Control+k');
    await page.getByPlaceholder(/search/i).fill(needle);
    // The same text exists in the chat behind the modal — click the RESULT.
    const result = page.locator('[data-testid="search-modal"]').getByText(`the ${needle} hides here`).first();
    await expect(result).toBeVisible({ timeout: 10_000 });
    await result.click();

    // The reported failure: a toast saying the messages could not load.
    await expect(page.getByText('Failed to load messages')).not.toBeVisible({ timeout: 3000 });
    const target = page.locator(`[data-message-id]`, { hasText: needle }).first();
    await expect(target).toBeVisible({ timeout: 10_000 });

    await context2.close();
  });
});
