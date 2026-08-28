import type { APIRequestContext, Browser, Page, WebSocketRoute } from '@playwright/test';
import { test, expect } from './helpers/fixtures';
import { testUser, injectAuth } from './helpers/auth';
import { registerUser, sendFriendRequest, acceptFriendRequest } from './helpers/api';
import { parseE2EEnvelope } from '../../packages/shared/src/e2e';

// Live two-client test of E2E-authenticated DM call signaling
// (docs/e2e-dm-spec.md §20). The media of a DM call was always DTLS-SRTP;
// what these tests pin down is the NEW property: every offer/answer/ICE
// candidate travels the wire as a pairwise-Olm envelope sealed to the peer's
// pinned device, and a plaintext signal is rejected loudly — never handled.
//
// First browser-level DM-call coverage in the repo: the fixtures pass
// --use-fake-device-for-media-stream, so getUserMedia yields a fake mic and
// two Chromium contexts can drive a real P2P call setup on localhost.

const CALL_PANEL = '[data-testid="dm-voice-panel"]';
const CALL_LOCK = '[data-testid="dm-call-e2e-lock"]';

/** Open the DM with a user from the Friends list. */
async function openDMWith(page: Page, username: string) {
  await page.getByText('Friends').first().click();
  await page.getByRole('button', { name: 'All' }).click();
  await expect(page.getByText(username, { exact: true }).first()).toBeVisible({ timeout: 10_000 });
  await page.locator('button[title="Message"]').first().click();
  await expect(page.locator('textarea')).toBeVisible({ timeout: 10_000 });
}

/** Two users, friended, both clients open (opening publishes each E2E device). */
async function setupCallPair(prefix: string, page: Page, request: APIRequestContext, browser: Browser) {
  const userA = testUser(`${prefix}a`);
  const userB = testUser(`${prefix}b`);
  const dataA = await registerUser(request, userA);
  const dataB = await registerUser(request, userB);
  await sendFriendRequest(request, dataA.accessToken, userB.username);
  await acceptFriendRequest(request, dataB.accessToken, dataA.user.id);

  await injectAuth(page, dataA);
  const contextB = await browser.newContext();
  const pageB = await contextB.newPage();
  await injectAuth(pageB, dataB);
  await expect(pageB.getByRole('heading', { name: 'Direct Messages' }).first()).toBeVisible({ timeout: 20_000 });

  return { userA, userB, dataA, dataB, pageB, contextB };
}

/** Ring from A's open DM, accept on B, wait until both panels show the call. */
async function connectCall(pageA: Page, pageB: Page) {
  await pageA.locator('button[title="Start Voice Call"]').click();
  await expect(pageA.locator(CALL_PANEL)).toBeVisible({ timeout: 15_000 });

  await expect(pageB.getByText('Incoming voice call...')).toBeVisible({ timeout: 15_000 });
  await pageB.locator('button[title="Accept"]').click();
  await expect(pageB.locator(CALL_PANEL)).toBeVisible({ timeout: 15_000 });

  // Connected, not just ringing: each side lists both participants
  await expect(pageA.locator(CALL_PANEL).getByText('In a Call')).toBeVisible({ timeout: 20_000 });
  await expect(pageB.locator(CALL_PANEL).getByText('In a Call')).toBeVisible({ timeout: 20_000 });
}

/** The `signal` payloads of every dm:voice:signal frame in a socket.io frame log. */
function extractSignalPayloads(frames: string[]): unknown[] {
  const signals: unknown[] = [];
  for (const frame of frames) {
    if (!frame.includes('"dm:voice:signal"')) continue;
    const idx = frame.indexOf('[');
    if (idx === -1) continue;
    try {
      const packet = JSON.parse(frame.slice(idx)) as unknown[];
      if (Array.isArray(packet) && packet[0] === 'dm:voice:signal') {
        signals.push((packet[1] as { signal?: unknown })?.signal);
      }
    } catch {
      // engine.io control frames ("2probe", "3", …) are not JSON — not signals
    }
  }
  return signals;
}

test.describe('E2E-authenticated DM calls', () => {
  test('call connects with the lock shown, only Olm envelopes on the wire, mute propagates, hangup tears down', async ({ page, request, browser }) => {
    test.setTimeout(180_000);

    // Passive wire tap on A's sockets BEFORE the app connects. Call signaling
    // rides the websocket transport (polling upgrades within the first second,
    // long before any call starts) — and if that assumption ever breaks, the
    // ≥2-signals assertion below fails rather than passing vacuously.
    const sentFrames: string[] = [];
    page.on('websocket', (ws) => {
      ws.on('framesent', (evt) => {
        if (typeof evt.payload === 'string') sentFrames.push(evt.payload);
      });
    });

    const { userB, pageB, contextB } = await setupCallPair('call', page, request, browser);

    // Signal decryption failing is invisible to the UI assertions below (the
    // panel is socket-driven) — so E2E signaling breakage must fail HERE.
    // This is what caught the Olm session-establishment glare bug.
    const macFailures: string[] = [];
    pageB.on('console', (m) => { if (/invalid MAC|decrypt.*failed/i.test(m.text())) macFailures.push(m.text()); });
    page.on('console', (m) => { if (/invalid MAC|decrypt.*failed/i.test(m.text())) macFailures.push(m.text()); });

    await openDMWith(page, userB.username);
    await connectCall(page, pageB);

    // ── The lock: signaling is pinned to the peer's E2E device on both sides ──
    await expect(page.locator(CALL_LOCK)).toBeVisible({ timeout: 10_000 });
    await expect(pageB.locator(CALL_LOCK)).toBeVisible({ timeout: 10_000 });

    // ── The wire: every signal A's client sent is an Olm envelope ──
    // ≥2 guarantees the tap saw real signaling (the offer plus at least one
    // ICE candidate), not an empty vacuous pass.
    const signals = extractSignalPayloads(sentFrames);
    expect(signals.length).toBeGreaterThanOrEqual(2);
    for (const signal of signals) {
      expect(typeof signal, `signal must be an envelope string, got: ${JSON.stringify(signal)}`).toBe('string');
      const envelope = parseE2EEnvelope(signal as string);
      expect(envelope, `not a parsable olm1 envelope: ${String(signal).slice(0, 80)}`).not.toBeNull();
      expect(envelope!.e).toBe('olm1');
    }

    // ── Mute propagates (socket state, unaffected by the E2E signal path) ──
    await page.locator(CALL_PANEL).locator('button[aria-label="Mute"]').click();
    await expect(pageB.locator(CALL_PANEL).locator('svg.lucide-mic-off').first()).toBeVisible({ timeout: 10_000 });

    // ── Hangup tears down both sides ──
    await page.locator(CALL_PANEL).locator('button[title="Disconnect"]').click();
    await expect(page.locator(CALL_PANEL)).toHaveCount(0, { timeout: 10_000 });
    await expect(pageB.locator(CALL_PANEL)).toHaveCount(0, { timeout: 15_000 });

    // Signaling must have actually WORKED, not just looked connected
    expect(macFailures, `E2E signal decryption failed:\n${macFailures.slice(0, 3).join('\n')}`).toEqual([]);

    await contextB.close();
  });

  test('a forged plaintext signal ABORTS the call — reject, never downgrade', async ({ page, request, browser }) => {
    test.setTimeout(180_000);

    const userA = testUser('forga');
    const userB = testUser('forgb');
    const dataA = await registerUser(request, userA);
    const dataB = await registerUser(request, userB);
    await sendFriendRequest(request, dataA.accessToken, userB.username);
    await acceptFriendRequest(request, dataB.accessToken, dataA.user.id);

    await injectAuth(page, dataA);

    // B's socket runs through a full websocket proxy so the test can act as a
    // malicious relay: after the call is up, inject the exact frame an
    // un-updated (or MITMing) server would deliver — a PLAINTEXT offer from
    // the legitimate call peer.
    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    let wsToPageB: WebSocketRoute | null = null;
    await pageB.routeWebSocket(/\/socket\.io\//, (ws) => {
      wsToPageB = ws;
      const server = ws.connectToServer();
      ws.onMessage((message) => server.send(message));
      server.onMessage((message) => ws.send(message));
    });
    await injectAuth(pageB, dataB);
    await expect(pageB.getByRole('heading', { name: 'Direct Messages' }).first()).toBeVisible({ timeout: 20_000 });

    await openDMWith(page, userB.username);
    // The untampered flow completes first — proof the abort tested below is
    // caused by the forgery, not by the proxy or the setup.
    await connectCall(page, pageB);
    await expect(pageB.locator(CALL_LOCK)).toBeVisible({ timeout: 10_000 });

    expect(wsToPageB, 'the websocket proxy must have captured B\'s socket').not.toBeNull();
    const forged = `42${JSON.stringify(['dm:voice:signal', {
      from: dataA.user.id,
      signal: { type: 'offer', sdp: 'v=0\r\no=forged 0 0 IN IP4 0.0.0.0\r\n' },
    }])}`;
    wsToPageB!.send(forged);

    // Hard cutover: B refuses the plaintext signal and kills the call loudly
    await expect(pageB.locator(CALL_PANEL)).toHaveCount(0, { timeout: 15_000 });
    await expect(pageB.getByText(/can't make secure calls/)).toBeVisible({ timeout: 10_000 });

    // B's abort is a normal leave from A's perspective: the 1:1 call ends and
    // A's panel tears down cleanly — no crash, no zombie call state
    await expect(page.locator(CALL_PANEL)).toHaveCount(0, { timeout: 15_000 });

    await contextB.close();
  });
});
