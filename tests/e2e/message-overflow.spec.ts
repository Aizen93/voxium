import { test, expect } from './helpers/fixtures';
import { testUser, injectAuth } from './helpers/auth';
import { registerUser, createServer, getServerChannels, API_URL } from './helpers/api';

/**
 * Message rows must stay inside the chat panel.
 *
 * Regression: horizontal padding lived on the Virtuoso scroller. Virtuoso's
 * item list is absolutely positioned, so its width:100% resolved against the
 * scroller's PADDING box — every row rendered 24px past the panel's right
 * edge, wide content (code blocks, unbroken text) ran under the People panel,
 * and the right-anchored hover toolbar (reply/react/edit/delete) was clipped
 * by the panel border. The padding belongs on the rows; these tests measure
 * the real geometry so the mistake cannot come back quietly.
 */
test.describe('message overflow containment', () => {
  test('wide content and the hover toolbar stay inside the message panel', async ({ page, request }) => {
    const userA = testUser('overflow');
    const dataA = await registerUser(request, userA);
    const server = await createServer(request, dataA.accessToken, `OverflowTest-${Date.now()}`);
    const channels = await getServerChannels(request, dataA.accessToken, server.id);
    const general = channels.find((c) => c.name === 'general');
    expect(general).toBeTruthy();

    // The two shapes that overflowed: a long unbroken token and a wide code block.
    const wide = [
      `unbroken ${'A'.repeat(400)} end`,
      '```\nconst reallyWideLine = "' + 'x'.repeat(300) + '";\n```',
    ];
    for (const content of wide) {
      const res = await request.post(`${API_URL}/channels/${general!.id}/messages`, {
        headers: { Authorization: `Bearer ${dataA.accessToken}` },
        data: { content },
      });
      expect(res.ok()).toBeTruthy();
    }

    await injectAuth(page, dataA);
    await page.getByRole('button', { name: server.name, exact: true }).click({ timeout: 10_000 });
    await expect(page.getByText('general').first()).toBeVisible({ timeout: 10_000 });
    await page.getByText('general').first().click();
    await expect(page.locator('[data-message-id]').first()).toBeVisible({ timeout: 10_000 });

    const scroller = page.locator('[data-virtuoso-scroller]');
    const scrollerBox = (await scroller.boundingBox())!;

    // Every message row must end at or before the scroller's right edge —
    // the bug put every row exactly one padding width (24px) past it.
    const rows = page.locator('[data-message-id]');
    const rowCount = await rows.count();
    expect(rowCount).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < rowCount; i++) {
      const box = (await rows.nth(i).boundingBox())!;
      expect(box.x + box.width, `row ${i} right edge`).toBeLessThanOrEqual(scrollerBox.x + scrollerBox.width + 1);
    }

    // The code block clips/scrolls inside its row rather than painting past it.
    const pre = page.locator('[data-message-id] pre').last();
    const preBox = (await pre.boundingBox())!;
    expect(preBox.x + preBox.width).toBeLessThanOrEqual(scrollerBox.x + scrollerBox.width + 1);

    // Hovering raises the action toolbar fully INSIDE the panel — when rows
    // overflowed, its right half sat past the panel border and was cut off.
    await rows.last().hover();
    const actions = page.locator('[data-testid="message-actions"]').last();
    await expect(actions).toBeVisible();
    const actionsBox = (await actions.boundingBox())!;
    expect(actionsBox.x + actionsBox.width).toBeLessThanOrEqual(scrollerBox.x + scrollerBox.width + 1);
    expect(actionsBox.width).toBeGreaterThan(40); // all buttons, not a clipped sliver
  });
});
