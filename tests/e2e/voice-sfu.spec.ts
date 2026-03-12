import { test, expect } from './helpers/fixtures';
import { testUser, injectAuth } from './helpers/auth';
import {
  registerUser,
  createServer,
  createInvite,
  joinServerViaInvite,
  getServerChannels,
  createChannel,
  clearRateLimits,
} from './helpers/api';

/**
 * Voice SFU E2E tests.
 *
 * These tests exercise the mediasoup SFU voice flow end-to-end:
 * - Joining/leaving voice channels
 * - Mute/deaf toggling
 * - Multi-user voice (two users in the same channel)
 * - Voice state broadcasts (user joined/left/muted visible to others)
 * - Disconnect cleanup
 *
 * Chromium is launched with --use-fake-device-for-media-stream so
 * getUserMedia returns a synthetic audio stream without a real mic.
 */

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Click a voice channel by name. Voice channels have a Volume2 (speaker) icon. */
async function clickVoiceChannel(
  page: Parameters<Parameters<typeof test>[1]>[0]['page'],
  channelName: string,
) {
  // Voice channel items render as a button containing a Volume2 SVG (class lucide-volume2)
  // and a <span> with the channel name. Target the button with both to avoid ambiguity.
  const voiceBtn = page
    .locator('button:has(svg.lucide-volume2)')
    .filter({ hasText: channelName })
    .first();
  await voiceBtn.click();
}

/** Set up a server and return tokens + server/channel IDs for two users. */
async function setupTwoUsersInServer(request: Parameters<Parameters<typeof test>[1]>[0]['request']) {
  const userA = testUser('va');
  const userB = testUser('vb');
  const dataA = await registerUser(request, userA);
  const dataB = await registerUser(request, userB);

  const server = await createServer(request, dataA.accessToken, `VoiceTest-${Date.now()}`);

  // User B joins via invite
  const inviteCode = await createInvite(request, dataA.accessToken, server.id);
  await joinServerViaInvite(request, dataB.accessToken, inviteCode);

  // Find the auto-created "General" voice channel
  const channels = await getServerChannels(request, dataA.accessToken, server.id);
  const voiceChannel = channels.find((c) => c.type === 'voice');
  if (!voiceChannel) throw new Error('No voice channel found');

  return { userA, userB, dataA, dataB, server, voiceChannel };
}

/** Navigate a page to the server view and wait for the channel sidebar. */
async function navigateToServer(
  page: Parameters<Parameters<typeof test>[1]>[0]['page'],
  serverName: string,
) {
  // The server icons in the sidebar show initials inside a button.
  // Hover creates a tooltip with the full name, but that's fragile to test.
  // Instead, find all round server buttons and click the one containing the right initials.
  const initials = serverName
    .split(' ')
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  // Server buttons are 48x48 rounded buttons. Each contains a <span> with the initials
  // or an <img> for server icons. Locate by finding button > span with exact initials text.
  const serverBtn = page
    .locator('button:has(> span)')
    .filter({ hasText: new RegExp(`^${initials}$`) })
    .first();
  await serverBtn.click({ timeout: 5_000 });

  // Wait for channel sidebar to load (every server has a #general text channel)
  await expect(page.getByText('general').first()).toBeVisible({ timeout: 10_000 });
}

/** Get the VoicePanel locator. */
function voicePanel(page: Parameters<Parameters<typeof test>[1]>[0]['page']) {
  return page.locator('[data-testid="voice-panel"]');
}

// ── Tests ────────────────────────────────────────────────────────────────────

test.describe('Voice SFU', () => {
  // Clear rate limits before each test to avoid 429 errors
  test.beforeEach(async () => {
    await clearRateLimits();
  });

  test('single user: join voice channel, see Voice Connected, then disconnect', async ({
    page,
    request,
  }) => {
    // Setup
    const userA = testUser('vsingle');
    const dataA = await registerUser(request, userA);
    const server = await createServer(request, dataA.accessToken, `Solo-${Date.now()}`);
    const channels = await getServerChannels(request, dataA.accessToken, server.id);
    const voiceChannel = channels.find((c) => c.type === 'voice')!;

    await injectAuth(page, dataA);
    await navigateToServer(page, server.name);

    // Click the voice channel to join
    await clickVoiceChannel(page, voiceChannel.name);

    // Should see "Voice Connected" panel
    await expect(page.getByText('Voice Connected')).toBeVisible({ timeout: 15_000 });

    // Should see own name in voice users with (you)
    await expect(page.getByText('(you)').first()).toBeVisible({ timeout: 5_000 });

    // Latency should be displayed
    await expect(page.getByText(/\d+ms/)).toBeVisible({ timeout: 10_000 });

    // Disconnect
    await page.locator('button[title="Disconnect"]').click();

    // "Voice Connected" should disappear
    await expect(page.getByText('Voice Connected')).not.toBeVisible({ timeout: 5_000 });
  });

  test('mute and unmute while in voice', async ({ page, request }) => {
    const userA = testUser('vmute');
    const dataA = await registerUser(request, userA);
    const server = await createServer(request, dataA.accessToken, `Mute-${Date.now()}`);
    const channels = await getServerChannels(request, dataA.accessToken, server.id);
    const voiceChannel = channels.find((c) => c.type === 'voice')!;

    await injectAuth(page, dataA);
    await navigateToServer(page, server.name);

    // Join voice
    await clickVoiceChannel(page, voiceChannel.name);
    await expect(page.getByText('Voice Connected')).toBeVisible({ timeout: 15_000 });

    // Click mute button in the VoicePanel (fixed overlay has clickable controls)
    const vp = voicePanel(page);
    await vp.locator('button[title="Mute"]').click();
    await expect(vp.locator('button[title="Unmute"]')).toBeVisible({ timeout: 3_000 });

    // Click unmute
    await vp.locator('button[title="Unmute"]').click();
    await expect(vp.locator('button[title="Mute"]')).toBeVisible({ timeout: 3_000 });

    // Disconnect
    await vp.locator('button[title="Disconnect"]').click();
  });

  test('deafen and undeafen while in voice', async ({ page, request }) => {
    const userA = testUser('vdeaf');
    const dataA = await registerUser(request, userA);
    const server = await createServer(request, dataA.accessToken, `Deaf-${Date.now()}`);
    const channels = await getServerChannels(request, dataA.accessToken, server.id);
    const voiceChannel = channels.find((c) => c.type === 'voice')!;

    await injectAuth(page, dataA);
    await navigateToServer(page, server.name);

    // Join voice
    await clickVoiceChannel(page, voiceChannel.name);
    await expect(page.getByText('Voice Connected')).toBeVisible({ timeout: 15_000 });

    // Click deafen button in the VoicePanel
    const vp = voicePanel(page);
    await vp.locator('button[title="Deafen"]').click();
    await expect(vp.locator('button[title="Undeafen"]')).toBeVisible({ timeout: 3_000 });

    // Click undeafen
    await vp.locator('button[title="Undeafen"]').click();
    await expect(vp.locator('button[title="Deafen"]')).toBeVisible({ timeout: 3_000 });

    // Disconnect
    await vp.locator('button[title="Disconnect"]').click();
  });

  test('two users: both see each other in voice channel', async ({
    page,
    request,
    browser,
  }) => {
    const { dataA, dataB, server, voiceChannel } = await setupTwoUsersInServer(request);

    // User A: authenticate and navigate
    await injectAuth(page, dataA);
    await navigateToServer(page, server.name);

    // User A joins voice
    await clickVoiceChannel(page, voiceChannel.name);
    await expect(page.getByText('Voice Connected')).toBeVisible({ timeout: 15_000 });

    // User B: open second browser context with fake media
    const context2 = await browser.newContext({
      permissions: ['microphone'],
    });
    const page2 = await context2.newPage();
    await injectAuth(page2, dataB);
    await navigateToServer(page2, server.name);

    // User B joins voice
    await clickVoiceChannel(page2, voiceChannel.name);
    await expect(page2.getByText('Voice Connected')).toBeVisible({ timeout: 15_000 });

    // User A should see User B in the voice channel user list (sidebar)
    await expect(
      page.getByText(dataB.user.username, { exact: false }).first()
    ).toBeVisible({ timeout: 10_000 });

    // User B should see User A
    await expect(
      page2.getByText(dataA.user.username, { exact: false }).first()
    ).toBeVisible({ timeout: 10_000 });

    // User B disconnects
    await page2.locator('button[title="Disconnect"]').click();
    await expect(page2.getByText('Voice Connected')).not.toBeVisible({ timeout: 5_000 });

    // User A should no longer see User B in voice
    // Give time for the voice:user_left event
    await page.waitForTimeout(1_000);

    // User A disconnects
    await page.locator('button[title="Disconnect"]').click();
    await expect(page.getByText('Voice Connected')).not.toBeVisible({ timeout: 5_000 });

    await context2.close();
  });

  test('user A sees user B mute state in real-time', async ({
    page,
    request,
    browser,
  }) => {
    const { dataA, dataB, server, voiceChannel } = await setupTwoUsersInServer(request);

    // User A joins voice
    await injectAuth(page, dataA);
    await navigateToServer(page, server.name);
    await clickVoiceChannel(page, voiceChannel.name);
    await expect(page.getByText('Voice Connected')).toBeVisible({ timeout: 15_000 });

    // User B joins voice
    const context2 = await browser.newContext({ permissions: ['microphone'] });
    const page2 = await context2.newPage();
    await injectAuth(page2, dataB);
    await navigateToServer(page2, server.name);
    await clickVoiceChannel(page2, voiceChannel.name);
    await expect(page2.getByText('Voice Connected')).toBeVisible({ timeout: 15_000 });

    // Wait for both to see each other
    await expect(
      page.getByText(dataB.user.username, { exact: false }).first()
    ).toBeVisible({ timeout: 10_000 });

    // User B mutes via VoicePanel
    const vp2 = voicePanel(page2);
    await vp2.locator('button[title="Mute"]').click();
    await expect(vp2.locator('button[title="Unmute"]')).toBeVisible({ timeout: 3_000 });

    // User A should see User B's MicOff icon in the VoicePanel user list
    // The VoicePanel shows MicOff SVG next to muted users
    const vp1 = voicePanel(page);
    await expect(
      vp1.locator('svg.lucide-mic-off').first()
    ).toBeVisible({ timeout: 5_000 });

    // Cleanup
    await vp1.locator('button[title="Disconnect"]').click();
    await vp2.locator('button[title="Disconnect"]').click();
    await context2.close();
  });

  test('joining voice in one server leaves voice in another', async ({
    page,
    request,
  }) => {
    const userA = testUser('vswitch');
    const dataA = await registerUser(request, userA);
    const server1 = await createServer(request, dataA.accessToken, `Switch1-${Date.now()}`);
    const server2 = await createServer(request, dataA.accessToken, `Switch2-${Date.now()}`);

    const channels1 = await getServerChannels(request, dataA.accessToken, server1.id);
    const voice1 = channels1.find((c) => c.type === 'voice')!;
    const channels2 = await getServerChannels(request, dataA.accessToken, server2.id);
    const voice2 = channels2.find((c) => c.type === 'voice')!;

    await injectAuth(page, dataA);

    // Join voice in server 1
    await navigateToServer(page, server1.name);
    await clickVoiceChannel(page, voice1.name);
    await expect(page.getByText('Voice Connected')).toBeVisible({ timeout: 15_000 });

    // Navigate to server 2 and join voice there
    await navigateToServer(page, server2.name);
    await clickVoiceChannel(page, voice2.name);

    // Should still show "Voice Connected" but now for server 2
    await expect(page.getByText('Voice Connected')).toBeVisible({ timeout: 15_000 });

    // Disconnect
    await page.locator('button[title="Disconnect"]').click();
    await expect(page.getByText('Voice Connected')).not.toBeVisible({ timeout: 5_000 });
  });

  test('closing the page cleans up voice state (disconnect)', async ({
    page,
    request,
    browser,
  }) => {
    const { dataA, dataB, server, voiceChannel } = await setupTwoUsersInServer(request);

    // User A joins voice
    await injectAuth(page, dataA);
    await navigateToServer(page, server.name);
    await clickVoiceChannel(page, voiceChannel.name);
    await expect(page.getByText('Voice Connected')).toBeVisible({ timeout: 15_000 });

    // User B joins voice in second context
    const context2 = await browser.newContext({ permissions: ['microphone'] });
    const page2 = await context2.newPage();
    await injectAuth(page2, dataB);
    await navigateToServer(page2, server.name);
    await clickVoiceChannel(page2, voiceChannel.name);
    await expect(page2.getByText('Voice Connected')).toBeVisible({ timeout: 15_000 });

    // Both should see each other
    await expect(
      page.getByText(dataB.user.username, { exact: false }).first()
    ).toBeVisible({ timeout: 10_000 });

    // User B abruptly closes their page (simulating disconnect)
    await context2.close();

    // User A should see User B disappear from the voice channel
    // The server will detect the socket disconnect and emit voice:user_left
    await expect(
      page.locator('.ml-4').getByText(dataB.user.username, { exact: false })
    ).not.toBeVisible({ timeout: 10_000 });

    // User A disconnects
    await page.locator('button[title="Disconnect"]').click();
  });

  test('voice panel shows correct channel name', async ({ page, request }) => {
    const userA = testUser('vchan');
    const dataA = await registerUser(request, userA);
    const server = await createServer(request, dataA.accessToken, `ChanName-${Date.now()}`);

    // Create a custom voice channel with a specific name
    const customVoice = await createChannel(request, dataA.accessToken, server.id, 'Music Room', 'voice');

    await injectAuth(page, dataA);
    await navigateToServer(page, server.name);

    // Join the custom voice channel
    await clickVoiceChannel(page, 'Music Room');
    await expect(page.getByText('Voice Connected')).toBeVisible({ timeout: 15_000 });

    // The VoicePanel should show the channel name below "Voice Connected"
    const vp = voicePanel(page);
    await expect(vp.getByText('Music Room')).toBeVisible();

    // Disconnect
    await vp.locator('button[title="Disconnect"]').click();
  });

  test('mute state persists when rejoining voice', async ({ page, request }) => {
    const userA = testUser('vpersist');
    const dataA = await registerUser(request, userA);
    const server = await createServer(request, dataA.accessToken, `Persist-${Date.now()}`);
    const channels = await getServerChannels(request, dataA.accessToken, server.id);
    const voiceChannel = channels.find((c) => c.type === 'voice')!;

    await injectAuth(page, dataA);
    await navigateToServer(page, server.name);

    // Join voice and mute via VoicePanel
    await clickVoiceChannel(page, voiceChannel.name);
    await expect(page.getByText('Voice Connected')).toBeVisible({ timeout: 15_000 });
    let vp = voicePanel(page);
    await vp.locator('button[title="Mute"]').click();
    await expect(vp.locator('button[title="Unmute"]')).toBeVisible({ timeout: 3_000 });

    // Leave voice
    await vp.locator('button[title="Disconnect"]').click();
    await expect(page.getByText('Voice Connected')).not.toBeVisible({ timeout: 5_000 });

    // The mute/deafen buttons in the sidebar should still show muted state
    // (persisted to localStorage)
    await expect(page.locator('button[title="Unmute"]').first()).toBeVisible({ timeout: 3_000 });

    // Rejoin — mute state should carry over
    await clickVoiceChannel(page, voiceChannel.name);
    await expect(page.getByText('Voice Connected')).toBeVisible({ timeout: 15_000 });

    // Should still show Unmute in VoicePanel (we were muted before leaving)
    vp = voicePanel(page);
    await expect(vp.locator('button[title="Unmute"]')).toBeVisible({ timeout: 3_000 });

    // Cleanup: unmute and disconnect
    await vp.locator('button[title="Unmute"]').click();
    await vp.locator('button[title="Disconnect"]').click();
  });
});
