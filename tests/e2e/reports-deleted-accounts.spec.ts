import { test, expect } from './helpers/fixtures';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { testUser } from './helpers/auth';
import {
  API_URL,
  clearRateLimits,
  registerUser,
  loginUser,
  createServer,
  createInvite,
  joinServerViaInvite,
  getServerChannels,
} from './helpers/api';
import { promoteToSuperAdmin } from './helpers/db';

// A moderation report and the deletion of an account it names, end to end:
// the real routes, the real database and the dashboard's moderation queue.
// The flag account_deletion_keeps_reports decides, at each deletion, whether
// the account's reports are deleted with it or kept without their link to it.

const ADMIN_URL = 'http://localhost:8082';
const FLAG = 'account_deletion_keeps_reports';

type Account = { username: string; email: string; password: string };

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

async function setFlag(request: APIRequestContext, adminToken: string, enabled: boolean) {
  const res = await request.put(`${API_URL}/admin/feature-flags/${FLAG}`, {
    data: { enabled },
    headers: bearer(adminToken),
  });
  expect(res.ok(), `the flag could not be set (${res.status()})`).toBe(true);
}

async function resetFlag(request: APIRequestContext, adminToken: string) {
  const res = await request.post(`${API_URL}/admin/feature-flags/${FLAG}/reset`, { headers: bearer(adminToken) });
  // Soft: it runs in a finally, and must not hide the failure that led there
  expect.soft(res.ok(), `the flag could not be reset (${res.status()})`).toBe(true);
}

async function reportAccount(request: APIRequestContext, token: string, reportedUserId: string, reason: string) {
  const res = await request.post(`${API_URL}/reports`, {
    data: { type: 'user', reportedUserId, reason },
    headers: bearer(token),
  });
  expect(res.ok(), `the account report was refused (${res.status()})`).toBe(true);
}

async function reportMessage(
  request: APIRequestContext,
  token: string,
  reportedUserId: string,
  messageId: string,
  reason: string,
) {
  const res = await request.post(`${API_URL}/reports`, {
    data: { type: 'message', reportedUserId, messageId, reason },
    headers: bearer(token),
  });
  expect(res.ok(), `the message report was refused (${res.status()})`).toBe(true);
}

async function sendChannelMessage(request: APIRequestContext, token: string, channelId: string, content: string) {
  const res = await request.post(`${API_URL}/channels/${channelId}/messages`, {
    data: { content },
    headers: bearer(token),
  });
  expect(res.ok(), `the message was refused (${res.status()})`).toBe(true);
  const { data } = await res.json();
  return data.id as string;
}

async function deleteOwnAccount(request: APIRequestContext, token: string, password: string) {
  const res = await request.delete(`${API_URL}/auth/account`, { data: { password }, headers: bearer(token) });
  expect(res.ok(), `the account deletion was refused (${res.status()})`).toBe(true);
}

type QueueRow = {
  reason: string;
  status: string;
  reporterId: string | null;
  reportedUserId: string | null;
  reportedUsername: string;
  reporterDeletedAt: string | null;
  reportedUserDeletedAt: string | null;
  expiresAt: string | null;
  messageId: string | null;
  messageContent: string | null;
};

/** The moderation queue as the dashboard's own route answers it, newest first. */
async function readQueue(request: APIRequestContext, adminToken: string): Promise<QueueRow[]> {
  const res = await request.get(`${API_URL}/admin/reports?filter=all&limit=100`, { headers: bearer(adminToken) });
  expect(res.ok(), `the queue could not be read (${res.status()})`).toBe(true);
  const body = await res.json();
  return (Array.isArray(body.data) ? body.data : body.data.reports) as QueueRow[];
}

async function signInToDashboard(page: Page, admin: Account) {
  await page.goto(`${ADMIN_URL}/login`);
  await page.getByPlaceholder('admin@example.com').fill(admin.email);
  await page.getByPlaceholder('Password').fill(admin.password);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible({ timeout: 15_000 });
}

async function openQueue(page: Page, tab: 'Pending' | 'Resolved' | 'All') {
  await page.getByRole('button', { name: 'Reports' }).click();
  await expect(page.getByText('Moderation Queue')).toBeVisible({ timeout: 10_000 });
  await page.locator('button', { hasText: new RegExp(`^${tab}$`) }).first().click();
}

/** The queue's row for one report, found by its reason (unique per run). */
function queueRow(page: Page, reason: string): Locator {
  return page.locator('tbody tr', { hasText: reason });
}

/** Twelve months, give or take the days a calendar month can differ by. */
function monthsBetween(from: string, to: string): number {
  return (new Date(to).getTime() - new Date(from).getTime()) / (30.44 * 24 * 60 * 60 * 1000);
}

test.describe('Reports and deleted accounts', () => {
  test('a report is kept without its account when the flag is on, and deleted with it when off', async ({ page, request }) => {
    test.setTimeout(240_000);
    const run = Date.now();

    // An administrator (who owns the space, so nobody under test owns one),
    // a reporter, an account that is reported and deleted, and one that is
    // reported and stays
    const admin = testUser('radm');
    const reporter = testUser('rrep');
    const deleted = testUser('rdel');
    const staying = testUser('rsta');
    const adminData = await registerUser(request, admin);
    const reporterData = await registerUser(request, reporter);
    const deletedData = await registerUser(request, deleted);
    const stayingData = await registerUser(request, staying);
    // Two more for the flag-off part. Six sign-ups from one address in a
    // minute is over the sign-up budget, which is not what this test is about
    await clearRateLimits();
    const laterReporter = testUser('rlat');
    const laterDeleted = testUser('rgon');
    const laterReporterData = await registerUser(request, laterReporter);
    const laterDeletedData = await registerUser(request, laterDeleted);
    await promoteToSuperAdmin(adminData.user.id);
    const adminToken = (await loginUser(request, { email: admin.email, password: admin.password })).accessToken;

    const space = await createServer(request, adminToken, `Reports ${run}`);
    await joinServerViaInvite(request, reporterData.accessToken, await createInvite(request, adminToken, space.id));
    await joinServerViaInvite(request, deletedData.accessToken, await createInvite(request, adminToken, space.id));
    const textChannel = (await getServerChannels(request, adminToken, space.id)).find((c) => c.type === 'text');
    expect(textChannel, 'the space has a text channel').toBeTruthy();

    const messageText = `a message that gets reported ${run}`;
    const messageId = await sendChannelMessage(request, deletedData.accessToken, textChannel!.id, messageText);

    const aboutAccount = `about the account ${run}`;
    const aboutMessage = `about the message ${run}`;
    const aboutStaying = `about an account that stays ${run}`;
    await reportAccount(request, reporterData.accessToken, deletedData.user.id, aboutAccount);
    await reportMessage(request, reporterData.accessToken, deletedData.user.id, messageId, aboutMessage);
    await reportAccount(request, reporterData.accessToken, stayingData.user.id, aboutStaying);

    try {
      // ── The flag on: the reported account is deleted, its reports stay ──
      await setFlag(request, adminToken, true);
      await deleteOwnAccount(request, deletedData.accessToken, deleted.password);

      let queue = await readQueue(request, adminToken);
      for (const reason of [aboutAccount, aboutMessage]) {
        const row = queue.find((r) => r.reason === reason);
        expect(row, `the report "${reason}" is kept`).toBeTruthy();
        expect(row!.status).toBe('pending');
        expect(row!.reportedUserId).toBeNull();
        expect(row!.reportedUsername).toBe(deleted.username);
        expect(row!.reporterId).toBe(reporterData.user.id);
        expect(row!.reportedUserDeletedAt).not.toBeNull();
        expect(row!.expiresAt).not.toBeNull();
        const months = monthsBetween(row!.reportedUserDeletedAt!, row!.expiresAt!);
        expect(months).toBeGreaterThan(11.9);
        expect(months).toBeLessThan(12.1);
      }
      // The copy of the reported message outlives the message itself
      const keptMessageReport = queue.find((r) => r.reason === aboutMessage)!;
      expect(keptMessageReport.messageContent).toBe(messageText);
      expect(keptMessageReport.messageId).toBeNull();
      // A report about an account that lives is untouched
      const untouched = queue.find((r) => r.reason === aboutStaying)!;
      expect(untouched.reportedUserId).toBe(stayingData.user.id);
      expect(untouched.expiresAt).toBeNull();

      // The dashboard shows the same
      await signInToDashboard(page, admin);
      await openQueue(page, 'Pending');
      const accountRow = queueRow(page, aboutAccount);
      await expect(accountRow).toBeVisible({ timeout: 10_000 });
      await expect(accountRow).toContainText(deleted.username);
      await expect(accountRow.getByTestId('report-reported-deleted')).toHaveText('Deleted account');
      await expect(accountRow.getByTestId('report-expires')).toContainText('Will be deleted on');
      await expect(accountRow.getByTestId('report-reporter-deleted')).toHaveCount(0);
      const stayingRow = queueRow(page, aboutStaying);
      await expect(stayingRow.getByTestId('report-reported-deleted')).toHaveCount(0);
      await expect(stayingRow.getByTestId('report-expires')).toHaveCount(0);

      // Resolving it offers nobody to ban, and resolves
      await accountRow.locator('button', { hasText: /^Resolve$/ }).click();
      await expect(page.getByText('Resolve Report')).toBeVisible({ timeout: 5_000 });
      await expect(page.getByTestId('report-ban-unavailable')).toContainText('no one to ban');
      await page.getByPlaceholder('Describe the resolution...').fill('Resolved after the account was deleted');
      await page.locator('.fixed').getByRole('button', { name: /^Resolve$/ }).click();
      await expect(page.getByText('Resolve Report')).not.toBeVisible({ timeout: 15_000 });
      await expect
        .poll(async () => (await readQueue(request, adminToken)).find((r) => r.reason === aboutAccount)?.status, { timeout: 10_000 })
        .toBe('resolved');

      // ── The reporter is deleted too: their reports stay, without them ──
      await deleteOwnAccount(request, reporterData.accessToken, reporter.password);
      queue = await readQueue(request, adminToken);
      const byDeletedReporter = queue.find((r) => r.reason === aboutStaying);
      expect(byDeletedReporter, 'the report by the deleted reporter is kept').toBeTruthy();
      expect(byDeletedReporter!.reporterId).toBeNull();
      expect(byDeletedReporter!.reporterDeletedAt).not.toBeNull();
      expect(byDeletedReporter!.reportedUserId).toBe(stayingData.user.id);
      expect(byDeletedReporter!.expiresAt).not.toBeNull();
      // Both of its accounts are gone now: the earlier deletion rules
      const bothGone = queue.find((r) => r.reason === aboutMessage)!;
      expect(bothGone.reporterId).toBeNull();
      expect(bothGone.reportedUserId).toBeNull();
      expect(new Date(bothGone.expiresAt!).getTime()).toBeLessThanOrEqual(new Date(byDeletedReporter!.expiresAt!).getTime());

      await page.reload();
      await openQueue(page, 'Pending');
      const reporterGoneRow = queueRow(page, aboutStaying);
      await expect(reporterGoneRow).toBeVisible({ timeout: 10_000 });
      await expect(reporterGoneRow.getByTestId('report-reporter-deleted')).toHaveText('Deleted account');
      await expect(reporterGoneRow.getByTestId('report-expires')).toContainText('Will be deleted on');
      await expect(reporterGoneRow).toContainText(staying.username);
      await expect(reporterGoneRow.getByTestId('report-reported-deleted')).toHaveCount(0);

      // ── The flag off: a deletion takes the account's reports with it ──
      await setFlag(request, adminToken, false);
      const aboutLater = `with the flag off ${run}`;
      await reportAccount(request, laterReporterData.accessToken, laterDeletedData.user.id, aboutLater);
      expect((await readQueue(request, adminToken)).some((r) => r.reason === aboutLater)).toBe(true);
      await deleteOwnAccount(request, laterDeletedData.accessToken, laterDeleted.password);
      queue = await readQueue(request, adminToken);
      expect(queue.some((r) => r.reason === aboutLater)).toBe(false);
      // What was kept while the flag was on stays kept
      expect(queue.some((r) => r.reason === aboutStaying)).toBe(true);
      expect(queue.some((r) => r.reason === aboutMessage)).toBe(true);
    } finally {
      await resetFlag(request, adminToken);
    }
  });
});
