import { test, expect } from './helpers/fixtures';
import { testUser, loginViaUI } from './helpers/auth';
import { registerUser, createServer, createChannel } from './helpers/api';

/**
 * How chatty is one ordinary session, and does any of it come back 429?
 *
 * The per-address request budget (`general`, middleware/rateLimiter.ts) is
 * shared by everyone behind one NAT, so the client's chattiness is what
 * decides how many colleagues can use Voxium from one office before the
 * server refuses ordinary reads. Measured when this landed (2026-10-24, dev
 * build, StrictMode doubling every mount effect): a sign-in plus the first
 * screen ~9 requests, two servers and six channels ~26, a reload ~9 — 44 in
 * the busiest minute with every duplicate coalesced, 56 once a GET issued
 * after a socket event stopped joining one issued before it (correctness
 * over the saving). The ceiling below is a tripwire for a runaway poll or
 * a fetch-on-every-render regression, not a target: it sits at a fifth of
 * the budget, so five such sessions still fit behind one address.
 */
const BUSIEST_MINUTE_CEILING = 200;

test('one ordinary session stays far inside the per-address budget and sees no 429', async ({ page, request }) => {
  test.setTimeout(180_000);
  const responses: Array<{ t: number; status: number; key: string }> = [];
  const t0 = Date.now();
  page.on('response', (res) => {
    if (!res.url().includes('/api/v1')) return;
    const path = new URL(res.url()).pathname.replace(/\/[0-9a-z]{20,}/g, '/:id');
    responses.push({ t: Date.now() - t0, status: res.status(), key: `${res.request().method()} ${path}` });
  });

  // A realistic account: two servers with a few channels each
  const user = testUser('budget');
  const data = await registerUser(request, user);
  const servers = [await createServer(request, data.accessToken, 'Budget One'), await createServer(request, data.accessToken, 'Budget Two')];
  for (const s of servers) {
    for (const name of ['random', 'dev']) await createChannel(request, data.accessToken, s.id, name);
  }

  // The login page itself asks the API for nothing
  await page.goto('/login');
  await page.waitForTimeout(3_000);
  expect(responses, 'the login page fired API requests before anything was typed').toHaveLength(0);

  await loginViaUI(page, user);
  await page.waitForTimeout(8_000);

  // Every click must land: a channel that is not there would silently shrink
  // what this measures
  for (const s of servers) {
    await page.getByRole('button', { name: s.name }).first().click();
    await expect(page.getByText('general', { exact: true }).first()).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(1_000);
    for (const ch of ['general', 'random', 'dev']) {
      const channel = page.getByText(ch, { exact: true }).first();
      await expect(channel).toBeVisible({ timeout: 10_000 });
      await channel.click();
      await page.waitForTimeout(800);
    }
  }

  await page.reload();
  await page.waitForTimeout(8_000);

  const refused = responses.filter((r) => r.status === 429);
  expect(refused, `429s during ordinary navigation: ${refused.map((r) => r.key).join(', ')}`).toHaveLength(0);

  let busiest = 0;
  for (let i = 0; i < responses.length; i++) {
    let j = i;
    while (j < responses.length && responses[j].t - responses[i].t < 60_000) j++;
    busiest = Math.max(busiest, j - i);
  }
  const perEndpoint = new Map<string, number>();
  for (const r of responses) perEndpoint.set(r.key, (perEndpoint.get(r.key) ?? 0) + 1);
  const summary = [...perEndpoint.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${k}`).join('\n');
  console.log(`[request-budget] ${responses.length} API requests, busiest minute ${busiest}\n${summary}`);
  expect(busiest, `busiest minute: ${busiest} requests\n${summary}`).toBeLessThanOrEqual(BUSIEST_MINUTE_CEILING);
});
