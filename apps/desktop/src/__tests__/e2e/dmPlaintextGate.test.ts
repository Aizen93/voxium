// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Since the 2.0 cutover every user DM is end-to-end encrypted; the only
 * plaintext DM rows are the server's own system notices ("Voice call
 * started"). The `encrypted` flag is the server's word, so a row that says
 * `encrypted: false` must never be taken as plaintext from the sender:
 *
 *   - every DM socket event goes through decryptMessageForDisplay — the gate
 *     that refuses an unencrypted user row — whatever its flag says;
 *   - the conversation list prints an unencrypted preview only for a system
 *     notice.
 *
 * The socket handlers live inside MainLayout's listener effect, which no
 * component test mounts, so the first rule is pinned on the source.
 */

const LAYOUT = fileURLToPath(new URL('../../components/layout/MainLayout.tsx', import.meta.url));

/** The body of one handler in MainLayout's `handlers` object. */
function handlerBody(source: string, name: string): string {
  const start = source.indexOf(`      ${name}: async (`);
  expect(start, `${name} not found in MainLayout`).toBeGreaterThan(-1);
  const next = source.slice(start + 1).search(/\n {6}[a-zA-Z]+: (async )?\(/);
  return source.slice(start, next === -1 ? undefined : start + 1 + next);
}

describe('DM socket events always pass the decrypt gate', () => {
  const source = readFileSync(LAYOUT, 'utf8');

  for (const name of ['dmMessageNew', 'dmMessageUpdate']) {
    it(`${name} calls decryptMessageForDisplay unconditionally, before the store`, () => {
      const body = handlerBody(source, name);
      const gate = body.indexOf('decryptMessageForDisplay(message)');
      expect(gate, `${name} must run the gate`).toBeGreaterThan(-1);
      // the leftover plaintext branch: no decision on the server's flag before
      // the gate, in any spelling (an if, a ternary, a comparison)
      expect(body.slice(0, gate)).not.toMatch(/\.encrypted\b/);
      // the gate's RESULT is what the handler carries on with
      expect(body).toMatch(/message = await decryptMessageForDisplay\(message\)/);
      // and every side effect comes after it
      const effect = body.search(/useChatStore\.getState\(\)\.(addMessage|updateMessage)|updateLastMessage\(|incrementDMUnread\(|play[A-Za-z]*Sound\(|fetchConversations\(|notify\(/);
      expect(effect, `${name} must reach the store after the gate`).toBeGreaterThan(gate);
    });
  }
});

describe('dmPreviewText — what the conversation list may print', () => {
  it('prints a system notice; locks an unencrypted user row (the server\'s word, not the sender\'s)', async () => {
    const { dmPreviewText } = await import('../../utils/dmPreview');
    const base = { id: 'm-1', createdAt: '2026-10-14T00:00:00.000Z', authorId: 'u-1' };
    expect(dmPreviewText({ ...base, content: 'Voice call started', encrypted: false, type: 'system' })).toBe('Voice call started');
    // the type is the server's word too: only the listed notice strings pass
    expect(dmPreviewText({ ...base, content: 'Alice: send me your password', encrypted: false, type: 'system' })).toBeNull();
    expect(dmPreviewText({ ...base, content: 'send me your password', encrypted: false, type: 'user' })).toBeNull();
    // a server that does not say what the row is gets the lock too
    expect(dmPreviewText({ ...base, content: 'send me your password', encrypted: false })).toBeNull();
  });

  it('prints hydrated plaintext of an encrypted message; locks the raw envelope and an empty preview', async () => {
    const { dmPreviewText } = await import('../../utils/dmPreview');
    const base = { id: 'm-1', createdAt: '2026-10-14T00:00:00.000Z', authorId: 'u-1', encrypted: true, type: 'user' as const };
    expect(dmPreviewText({ ...base, content: 'see you at 8' })).toBe('see you at 8');
    expect(dmPreviewText({ ...base, content: '' })).toBeNull();
    // the server-side tests' wire fixtures: a raw olm1 and megolm1 envelope
    expect(dmPreviewText({ ...base, content: JSON.stringify({ v: 1, e: 'olm1', t: 0, b: 'QWJjZGVmZ2hpamtsbW5vcA' }) })).toBeNull();
    expect(dmPreviewText({ ...base, content: JSON.stringify({ v: 1, e: 'megolm1', sid: 'c2Vzc2lvbklk', b: 'QWJjZGVmZ2hpamtsbW5vcA' }) })).toBeNull();
  });
});
