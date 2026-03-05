import { test, expect } from './helpers/fixtures';
import { testUser } from './helpers/auth';
import { registerUser, API_URL } from './helpers/api';
import { promoteToSuperAdmin, createReport, createSupportTicket, disconnectDb } from './helpers/db';

const ADMIN_URL = 'http://localhost:8082';

test.afterAll(async () => {
  await disconnectDb();
});

test.describe('Admin flow: login -> manage users -> resolve report -> close ticket', () => {
  test('full admin flow', async ({ page, request }) => {
    // === Setup: Create admin user, regular user, report, and support ticket ===
    const adminUser = testUser('adm');
    const regularUser = testUser('usr');
    const adminData = await registerUser(request, adminUser);
    const userData = await registerUser(request, regularUser);

    // Promote to superadmin via DB
    await promoteToSuperAdmin(adminData.user.id);

    // Create a report from regular user against admin (just for testing the report flow)
    const reportReason = `E2E test report ${Date.now()}`;
    await createReport(userData.user.id, adminData.user.id, reportReason);

    // Create a support ticket from regular user
    const ticketMessage = `E2E support request ${Date.now()}`;
    await createSupportTicket(userData.user.id, ticketMessage);

    // Re-login to get fresh token with superadmin role
    const freshAdmin = await request.post(`${API_URL}/auth/login`, {
      data: { email: adminUser.email, password: adminUser.password },
    });
    const { data: loginData } = await freshAdmin.json();

    // === Step 1: Login to admin panel ===
    await page.goto(`${ADMIN_URL}/login`);
    await expect(page.getByText('Voxium Admin')).toBeVisible();

    // Inject auth tokens (faster than typing into the form)
    await page.evaluate((tokens) => {
      localStorage.setItem('voxium_access_token', tokens.accessToken);
      localStorage.setItem('voxium_refresh_token', tokens.refreshToken);
    }, loginData);
    await page.goto(ADMIN_URL);

    // Should see the admin dashboard
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Total Users')).toBeVisible({ timeout: 10_000 });

    // === Step 2: Navigate to Users and verify user list ===
    await page.getByRole('button', { name: 'Users' }).click();
    await expect(page.getByText('Users').first()).toBeVisible();

    // Search for the regular user
    await page.getByPlaceholder('Search users by name, email...').fill(regularUser.username);
    await page.getByRole('button', { name: 'Search' }).click();
    await expect(page.getByText(regularUser.username, { exact: true })).toBeVisible({ timeout: 10_000 });

    // === Step 3: Navigate to Reports and resolve the report ===
    await page.getByRole('button', { name: 'Reports' }).click();
    await expect(page.getByText('Moderation Queue')).toBeVisible({ timeout: 10_000 });

    // Click "Pending" filter tab in the reports page
    const pendingFilterBtn = page.locator('button', { hasText: /^Pending$/ }).first();
    await pendingFilterBtn.click();
    // Wait for the pending report to appear
    await expect(page.getByText(reportReason).first()).toBeVisible({ timeout: 10_000 });

    // Click the "Resolve" action button in the table row
    const resolveBtn = page.locator('button', { hasText: /^Resolve$/ }).first();
    await resolveBtn.click();

    // Resolve modal should appear
    await expect(page.getByText('Resolve Report')).toBeVisible({ timeout: 5_000 });

    // Fill resolution note and confirm
    await page.getByPlaceholder('Describe the resolution...').fill('Resolved via E2E test');
    // Click the confirm button inside the modal overlay
    await page.locator('.fixed').getByRole('button', { name: /Resolve/i }).click();

    // Wait for the modal to close (confirm modal disappears after API success)
    await expect(page.getByText('Resolve Report')).not.toBeVisible({ timeout: 15_000 });

    // === Step 4: Navigate to Support and handle the ticket ===
    await page.getByRole('button', { name: 'Support' }).click();
    await expect(page.getByText('Support Tickets')).toBeVisible({ timeout: 10_000 });

    // Filter to Open tickets to find our newly created ticket
    await page.locator('button', { hasText: /^Open$/ }).first().click();

    // Should see the open ticket
    await expect(page.getByText(regularUser.username, { exact: false }).first()).toBeVisible({ timeout: 10_000 });

    // Click on the ticket to select it
    await page.getByText(regularUser.username, { exact: false }).first().click();

    // Should see the ticket message
    await expect(page.getByText(ticketMessage)).toBeVisible({ timeout: 10_000 });

    // Claim the ticket
    await page.getByRole('button', { name: 'Claim', exact: true }).click();
    await expect(page.getByText('Claimed', { exact: true }).first()).toBeVisible({ timeout: 10_000 });

    // Send a staff reply
    const staffReply = `Staff response ${Date.now()}`;
    await page.getByPlaceholder('Type a message...').fill(staffReply);
    await page.keyboard.press('Enter');
    await expect(page.getByText(staffReply)).toBeVisible({ timeout: 10_000 });

    // Close the ticket
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(page.getByText('Closed', { exact: true }).first()).toBeVisible({ timeout: 10_000 });

    // === Step 5: Verify audit log has entries ===
    await page.getByRole('button', { name: 'Audit Log' }).click();
    await expect(page.getByText('Audit Log').first()).toBeVisible({ timeout: 10_000 });

    // Should show support and report audit entries (use table locator to avoid matching hidden <option> elements)
    await expect(page.locator('table').getByText('Ticket Closed').first()).toBeVisible({ timeout: 10_000 });
  });
});
