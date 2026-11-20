import type { Page, APIRequestContext, Browser } from '@playwright/test';
import { test, expect } from './helpers/fixtures';
import { testUser, injectAuth } from './helpers/auth';
import {
  registerUser,
  createServer,
  createInvite,
  joinServerViaInvite,
  getServerChannels,
} from './helpers/api';
import {
  stageVideo,
  maxCanvasAlphaAround,
  sampleVideoRegion,
  dragOnLayer,
  expectVideoPlaying,
  type NormRect,
} from './helpers/screenShare';

/**
 * Screen sharing, annotations and privacy masks, end to end (issue #78).
 *
 * Two users sit in one voice channel; A shares, B views. The capture is
 * Chromium's synthetic display source (the config's
 * --use-fake-device-for-media-stream and --use-fake-ui-for-media-stream), so
 * the picture is real video frames travelling through the SFU. What the
 * viewer sees is read back from the DOM: the <video> element's pixels and
 * the annotation <canvas>.
 */

type Req = APIRequestContext;

async function setup(request: Req) {
  const userA = testUser('sa');
  const userB = testUser('sb');
  const dataA = await registerUser(request, userA);
  const dataB = await registerUser(request, userB);
  const server = await createServer(request, dataA.accessToken, `Share-${Date.now()}`);
  const invite = await createInvite(request, dataA.accessToken, server.id);
  await joinServerViaInvite(request, dataB.accessToken, invite);
  const channels = await getServerChannels(request, dataA.accessToken, server.id);
  const voiceChannel = channels.find((c) => c.type === 'voice');
  if (!voiceChannel) throw new Error('No voice channel found');
  return { dataA, dataB, server, voiceChannel };
}

async function openServer(page: Page, serverName: string) {
  const initials = serverName
    .split(' ')
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
  await page
    .locator('button:has(> span)')
    .filter({ hasText: new RegExp(`^${initials}$`) })
    .first()
    .click({ timeout: 5_000 });
  await expect(page.getByText('general').first()).toBeVisible({ timeout: 10_000 });
}

async function joinVoice(page: Page, channelName: string) {
  await page
    .locator('button:has(svg.lucide-volume-2)')
    .filter({ hasText: channelName })
    .first()
    .click();
  await expect(page.getByText('Voice Connected')).toBeVisible({ timeout: 15_000 });
}

/** A second signed-in browser context (the viewer). */
async function openViewer(
  browser: Browser,
  data: Awaited<ReturnType<typeof registerUser>>,
  serverName: string,
  channelName: string,
) {
  const context = await browser.newContext({ permissions: ['microphone'] });
  const page = await context.newPage();
  await injectAuth(page, data);
  await openServer(page, serverName);
  await joinVoice(page, channelName);
  return { context, page };
}

const voicePanel = (page: Page) => page.getByTestId('voice-panel');

/** Start a share from the voice panel; the pre-flight dialog opens. */
async function beginShare(page: Page) {
  await voicePanel(page).getByRole('button', { name: 'Share Screen', exact: true }).click();
  await expect(page.getByTestId('share-preflight-dialog')).toBeVisible({ timeout: 15_000 });
  // The local preview inside the dialog plays before anything is shared
  await expect
    .poll(() => page.getByTestId('share-preflight-dialog').locator('video').evaluate((v: HTMLVideoElement) => v.videoWidth))
    .toBeGreaterThan(0);
}

async function goLive(page: Page) {
  await page.getByTestId('preflight-go-live').click();
  await expect(page.getByTestId('share-preflight-dialog')).toBeHidden();
  await expect(page.getByTestId('sharing-indicator')).toBeVisible({ timeout: 15_000 });
}

test.describe('Screen share', () => {
  test.setTimeout(90_000);

  test('share, annotate, replay to a rejoining viewer, clear and stop', async ({ page, request, browser }) => {
    const { dataA, dataB, server, voiceChannel } = await setup(request);

    await injectAuth(page, dataA);
    await openServer(page, server.name);
    await joinVoice(page, voiceChannel.name);
    const viewer = await openViewer(browser, dataB, server.name, voiceChannel.name);
    const pageB = viewer.page;

    // ── 1. Start: pre-flight, go live, indicator for A, playing video for B ──
    await beginShare(page);
    await expect(page.getByTestId('preflight-monitor-nudge')).toBeVisible();
    await goLive(page);
    await expect(page.getByTestId('sharing-indicator')).toContainText('You are sharing your screen');

    await expect(pageB.getByText(`${dataA.user.username} is sharing their screen`)).toBeVisible({ timeout: 15_000 });
    await expect(pageB.getByTestId('sharing-indicator')).toHaveCount(0);
    await expectVideoPlaying(pageB);
    await expectVideoPlaying(page);

    // ── 2. Annotation: A draws a stroke, B's canvas shows it ─────────────
    await page.getByRole('button', { name: 'Annotate', exact: true }).click();
    await expect(page.getByTestId('annotation-toolbar')).toBeVisible();
    await page.locator('[data-tool="pen"]').click();
    await page.getByRole('button', { name: 'Stroke width thick', exact: true }).click();
    const layer = page.getByTestId('annotation-editor-layer');
    await expect(layer).toBeVisible();

    const onInk = { x: 0.5, y: 0.5 };
    const offInk = { x: 0.5, y: 0.85 };
    await dragOnLayer(page, layer, { x: 0.2, y: 0.5 }, { x: 0.8, y: 0.5 });

    await expect.poll(() => maxCanvasAlphaAround(pageB, onInk.x, onInk.y), { message: 'B sees the stroke' }).toBeGreaterThan(0);
    expect(await maxCanvasAlphaAround(pageB, offInk.x, offInk.y)).toBe(0);
    // A's own canvas shows it as well
    expect(await maxCanvasAlphaAround(page, onInk.x, onInk.y)).toBeGreaterThan(0);

    // Undo removes it on both sides
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect.poll(() => maxCanvasAlphaAround(pageB, onInk.x, onInk.y), { message: 'undo reaches B' }).toBe(0);

    // Draw again; a viewer who leaves and comes back gets the scene replayed
    await dragOnLayer(page, layer, { x: 0.2, y: 0.5 }, { x: 0.8, y: 0.5 });
    await expect.poll(() => maxCanvasAlphaAround(pageB, onInk.x, onInk.y)).toBeGreaterThan(0);

    await pageB.locator('button[title="Disconnect"]').click();
    await expect(pageB.getByText('Voice Connected')).toBeHidden();
    await expect(stageVideo(pageB)).toHaveCount(0);
    await joinVoice(pageB, voiceChannel.name);
    await expectVideoPlaying(pageB);
    await expect
      .poll(() => maxCanvasAlphaAround(pageB, onInk.x, onInk.y), { message: 'the scene is replayed to a rejoining viewer' })
      .toBeGreaterThan(0);

    // Clear all wipes it on B
    await page.getByRole('button', { name: 'Clear all', exact: true }).click();
    await expect.poll(() => maxCanvasAlphaAround(pageB, onInk.x, onInk.y), { message: 'clear reaches B' }).toBe(0);

    // ── 4. Stop: B's stage and A's indicator go away ─────────────────────
    await voicePanel(page).getByRole('button', { name: 'Stop Sharing', exact: true }).click();
    await expect(page.getByTestId('sharing-indicator')).toHaveCount(0);
    await expect(stageVideo(pageB)).toHaveCount(0);
    await expect(pageB.getByText(`${dataA.user.username} is sharing their screen`)).toHaveCount(0);

    await viewer.context.close();
  });

  test('privacy mask: covered on the viewer, uncovered once removed', async ({ page, request, browser }) => {
    const { dataA, dataB, server, voiceChannel } = await setup(request);

    await injectAuth(page, dataA);
    await openServer(page, server.name);
    await joinVoice(page, voiceChannel.name);
    const viewer = await openViewer(browser, dataB, server.name, voiceChannel.name);
    const pageB = viewer.page;

    // Mask placed in the pre-flight dialog, before the first frame leaves
    await beginShare(page);
    const maskBox: NormRect = { x: 0.1, y: 0.1, w: 0.3, h: 0.3 };
    const inside: NormRect = { x: 0.15, y: 0.15, w: 0.2, h: 0.2 };
    const outside: NormRect = { x: 0.6, y: 0.6, w: 0.3, h: 0.3 };
    await expect(page.getByTestId('share-preflight-dialog').locator('[data-preflight-tool="mask"]')).toHaveAttribute('aria-pressed', 'true');
    await dragOnLayer(
      page,
      page.getByTestId('annotation-editor-layer'),
      { x: maskBox.x, y: maskBox.y },
      { x: maskBox.x + maskBox.w, y: maskBox.y + maskBox.h },
    );
    await expect(page.getByTestId('share-preflight-dialog')).toContainText('1 mask');
    await goLive(page);
    await expectVideoPlaying(pageB);

    // Viewer: the masked region is a solid cover, the rest is the capture
    await expect
      .poll(async () => (await sampleVideoRegion(pageB, inside)).luma, { message: 'masked region is covered' })
      .toBeLessThan(8);
    // The synthetic capture is a green frame; outside the mask it arrives as is
    const picture = await sampleVideoRegion(pageB, outside);
    expect(picture.g).toBeGreaterThan(100);

    // Remove the mask while live: select it, press Delete
    await page.getByRole('button', { name: 'Annotate', exact: true }).click();
    await page.locator('[data-tool="select"]').click();
    const layer = page.getByTestId('annotation-editor-layer');
    const box = await layer.boundingBox();
    if (!box) throw new Error('no layer box');
    await page.mouse.click(box.x + (maskBox.x + maskBox.w / 2) * box.width, box.y + (maskBox.y + maskBox.h / 2) * box.height);
    await page.keyboard.press('Delete');

    await expect
      .poll(async () => (await sampleVideoRegion(pageB, inside)).g, { message: 'region shows the capture again' })
      .toBeGreaterThan(100);

    await viewer.context.close();
  });
});
