// @vitest-environment node
// A source scan, like mainLayoutKickToast.test.ts: MainLayout's socket
// handlers are mounted by no component test, so their wiring is pinned on the
// source and what they call is tested in the store.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const LAYOUT = fileURLToPath(new URL('../../components/layout/MainLayout.tsx', import.meta.url));
const source = readFileSync(LAYOUT, 'utf8');

/** One handler's source: from `name:` to the next handler named `next:`. */
function handler(name: string, next: string): string {
  const start = source.indexOf(`${name}:`);
  expect(start, `${name} handler not found in MainLayout`).toBeGreaterThan(-1);
  const end = source.indexOf(`${next}:`, start);
  expect(end, `end of ${name} handler not found`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('MainLayout hands the end of a call to the voice store', () => {
  it('dm:voice:ended goes to the store whole, the re-join mark included (only the store can tell whose answer it is)', () => {
    const body = handler('dmVoiceEnded', 'dmConversationDeleted');
    expect(body).toMatch(/useVoiceStore\.getState\(\)\.handleDMVoiceEnded\(data\)/);
    // No decision of its own on the conversation or the ring
    expect(body).not.toMatch(/dmCallConversationId/);
    expect(body).not.toMatch(/handleDMCallEnded|setIncomingCall/);
  });

  it('a space deleted while in its voice channel ends the call through the store, with no teardown of its own', () => {
    const body = handler('serverDeleted', 'announcementInit');
    expect(body).toMatch(/voiceState\.handleVoiceChannelGone\(\)/);
    // Not leaveChannel (it would say voice:leave to a server that already
    // removed the session), and no piece of the teardown done here by hand
    expect(body).not.toMatch(/leaveChannel\(/);
    expect(body).not.toMatch(/stopSpeakingDetection|stopNoiseSuppression|cleanupSFU|teardownSecureVoice|getTracks\(\)/);
    expect(body).not.toMatch(/activeChannelId: null/);
  });
});
