import type { Page } from '@playwright/test';
import { test, expect } from './helpers/fixtures';
import { testUser, injectAuth } from './helpers/auth';
import { registerUser, createServer, createInvite, joinServerViaInvite, deleteServer } from './helpers/api';
import { seedServerMembers, deleteSeededUsers } from './helpers/db';
import { MEMBER_LIST } from '@voxium/shared';

// Live test of the member lists on a BIG server (CLAUDE.md "Server Membership"):
//   (a) the People panel is a presence view — on a server past the panel cap
//       it loads the online members only, the Offline section becomes a count
//       and a way into the directory, and a member coming online appears live
//       (the client had no row for them: the batched lookup fetched it);
//   (b) Server settings → Members is a server-paged directory — the first
//       page, the next page, a search for a member deep in the list, and the
//       role filter — reading the server's figures, never the rows on screen;
//   (c) a small server keeps listing its offline members in the panel.
// The membership is seeded straight into the database: registering five
// hundred users through the API would take minutes and burn every budget.

/** The panel cap the server applies; the seed goes past it. */
const PEOPLE_MAX_ROWS = MEMBER_LIST.PEOPLE_MAX_ROWS;
const PAGE = 100;

async function waitForApp(page: Page) {
  await expect(page.getByTestId('spaces-strip')).toBeVisible({ timeout: 90_000 });
}

async function openServer(page: Page, serverName: string) {
  await waitForApp(page);
  await page.getByRole('button', { name: serverName, exact: true }).click({ timeout: 15_000 });
  await expect(page.locator('textarea')).toBeVisible({ timeout: 15_000 });
}

test.describe('Member lists — big servers', () => {
  // A `finally` in the test body does not run when the test times out; the
  // seeded accounts are verified, so no sweep would ever remove them
  let cleanup: (() => Promise<void>) | null = null;
  test.afterEach(async () => {
    const run = cleanup;
    cleanup = null;
    if (run) await run();
  });

  test('the People panel shows the online slice and a way into the directory; the directory pages, searches and filters', async ({ page, request, browser }) => {
    test.setTimeout(180_000);
    const stamp = Date.now().toString(36);
    const serverName = `Big Lab ${stamp}`;
    const seedPrefix = `seed${stamp}`;
    const owner = await registerUser(request, testUser('bigo'));
    const server = await createServer(request, owner.accessToken, serverName);
    cleanup = async () => {
      await deleteSeededUsers(seedPrefix);
      await deleteServer(request, owner.accessToken, server.id).catch((err) => console.warn('[e2e] server cleanup failed:', err));
    };
    const bob = await registerUser(request, testUser('bigb'));
    await joinServerViaInvite(request, bob.accessToken, await createInvite(request, owner.accessToken, server.id));
    const seeded = await seedServerMembers(server.id, PEOPLE_MAX_ROWS + 20, seedPrefix);
    const total = seeded.length + 2;

    {
      // ── (a) the panel: the owner online; bob and the seeded members offline, so not listed ──
      await injectAuth(page, owner);
      await openServer(page, serverName);
      const people = page.getByTestId('people-panel');
      const browse = people.getByTestId('people-browse-all');
      await expect(browse).toBeVisible({ timeout: 15_000 });
      await expect(people.getByText(bob.user.username, { exact: true })).toHaveCount(0);
      await expect(people.getByText(seeded[0], { exact: true })).toHaveCount(0);
      await expect(people.getByText(owner.user.username, { exact: true })).toBeVisible();
      await expect(people.getByTestId('people-online-count')).toHaveText('1');
      await expect(people.getByText(`Offline · ${total - 1}`)).toBeVisible();

      // bob connects elsewhere: the owner's client had no row for him and
      // asks for it — he appears under Active, and the count follows
      const bobContext = await browser.newContext();
      const bobPage = await bobContext.newPage();
      await injectAuth(bobPage, bob);
      await waitForApp(bobPage);
      await expect(people.getByText(bob.user.username, { exact: true })).toBeVisible({ timeout: 15_000 });
      await expect(people.getByTestId('people-online-count')).toHaveText('2');
      await expect(people.getByText(`Offline · ${total - 2}`)).toBeVisible();

      // ── (b) the directory, from the panel's link: a plain dialog, never Server settings ──
      await browse.click();
      const dialog = page.getByTestId('members-dialog');
      await expect(dialog).toBeVisible({ timeout: 15_000 });
      await expect(dialog.getByTestId('members-directory')).toBeVisible({ timeout: 15_000 });
      await expect(dialog.getByTestId('join-requests')).toHaveCount(0);
      await expect(dialog.getByTestId('tab-discovery')).toHaveCount(0);
      const rows = dialog.getByTestId('member-row');
      await expect(rows).toHaveCount(PAGE, { timeout: 15_000 });
      // owner first, then by join date: bob joined before the seed
      await expect(rows.nth(0)).toContainText(owner.user.username);
      await expect(rows.nth(1)).toContainText(bob.user.username);
      await expect(dialog.getByTestId('members-count')).toHaveText(`${total} of ${total} members`);

      await dialog.getByTestId('members-load-more').click();
      await expect(rows).toHaveCount(PAGE * 2, { timeout: 15_000 });
      // every row of the second page is a seeded member, none repeated
      const shown = await rows.allTextContents();
      expect(new Set(shown).size).toBe(PAGE * 2);
      expect(shown.slice(PAGE).every((text) => text.includes(seedPrefix))).toBe(true);

      // a member deep in the list, by name
      const deep = seeded[seeded.length - 1];
      await dialog.getByTestId('members-search').fill(deep);
      await expect(rows).toHaveCount(1, { timeout: 15_000 });
      await expect(rows.first()).toContainText(deep);
      await expect(dialog.getByTestId('members-count')).toHaveText(`1 of ${total} members`);
      await expect(dialog.getByTestId('members-load-more')).toHaveCount(0);

      // the role filter: owners
      await dialog.getByTestId('members-search').fill('');
      await dialog.getByTestId('members-role-filter').selectOption('owner');
      await expect(rows).toHaveCount(1, { timeout: 15_000 });
      await expect(rows.first()).toContainText(owner.user.username);
      await expect(dialog.getByTestId('members-count')).toHaveText(`1 of ${total} members`);

      // no role at all: everyone but nobody is filtered out yet (no custom roles) — two pages again
      await dialog.getByTestId('members-role-filter').selectOption('none');
      await expect(rows).toHaveCount(PAGE, { timeout: 15_000 });
      await expect(dialog.getByTestId('members-count')).toHaveText(`${total} of ${total} members`);

      await bobContext.close();
    }
  });

  test('a small server still lists its offline members in the panel, and the directory reads the same figures', async ({ page, request }) => {
    test.setTimeout(120_000);
    const stamp = Date.now().toString(36);
    const serverName = `Small Lab ${stamp}`;
    const owner = await registerUser(request, testUser('smo'));
    const server = await createServer(request, owner.accessToken, serverName);
    const bob = await registerUser(request, testUser('smb'));
    await joinServerViaInvite(request, bob.accessToken, await createInvite(request, owner.accessToken, server.id));

    await injectAuth(page, owner);
    await openServer(page, serverName);
    const people = page.getByTestId('people-panel');
    await expect(people.getByText(bob.user.username, { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(people.getByText('Offline · 1')).toBeVisible();
    await expect(people.getByTestId('people-browse-all')).toHaveCount(0);
    await expect(people.getByTestId('people-online-count')).toHaveText('1');

    await page.getByLabel('Space Settings').click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: /^Members/ }).click();
    await expect(dialog.getByTestId('member-row')).toHaveCount(2, { timeout: 15_000 });
    await expect(dialog.getByTestId('members-count')).toHaveText('2 of 2 members');
    await expect(dialog.getByTestId('members-load-more')).toHaveCount(0);
  });
});
