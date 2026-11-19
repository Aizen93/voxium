// @vitest-environment node
// A source scan, like mainLayoutBansWiring.test.ts: MainLayout's listener
// effect is mounted by no component test.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const LAYOUT = fileURLToPath(new URL('../../components/layout/MainLayout.tsx', import.meta.url));
const source = readFileSync(LAYOUT, 'utf8');

function voiceUserLeftHandler(): string {
  const start = source.indexOf('voiceUserLeft:');
  expect(start, 'voiceUserLeft handler not found in MainLayout').toBeGreaterThan(-1);
  const end = source.indexOf('voiceStateUpdate:', start);
  expect(end, 'end of voiceUserLeft handler not found in MainLayout').toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('MainLayout hands a voice departure\'s epoch to the store', () => {
  it('passes the epoch on, and a departure the store ignores ends the handler before the leave sound', () => {
    const handler = voiceUserLeftHandler();
    expect(handler).toMatch(/\{\s*channelId,\s*userId,\s*epoch\s*\}/);
    const ignored = handler.search(/removeUserFromChannel\(channelId, userId, epoch\) === false\) return;/);
    expect(ignored, 'the store\'s answer is not checked').toBeGreaterThan(-1);
    const sound = handler.indexOf('playLeaveSound()');
    expect(sound).toBeGreaterThan(ignored);
    // The store is asked once
    expect(handler.match(/removeUserFromChannel\(/g) ?? []).toHaveLength(1);
  });

  it('the event table routes voice:user_left to that handler', () => {
    expect(source).toMatch(/\['voice:user_left', handlers\.voiceUserLeft\]/);
  });
});
