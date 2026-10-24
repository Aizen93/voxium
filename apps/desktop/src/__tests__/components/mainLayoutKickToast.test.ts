// @vitest-environment node
// A source scan, like mainLayoutWebhookWiring.test.ts: MainLayout's socket
// handlers are mounted by no component test, so the wording is pinned on the source.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * `member:kicked` reaches the removed member after the kick route ran
 * removeMemberFromServer WITH a ban: since server discovery every kick is a
 * remove-and-ban, and the member cannot come back by invite, directly or by
 * request until unbanned. The toast said "You were kicked from the server", in
 * English in every locale, which no longer described what happened.
 */

const LAYOUT = fileURLToPath(new URL('../../components/layout/MainLayout.tsx', import.meta.url));
const LOCALE_DIR = fileURLToPath(new URL('../../i18n/locales/', import.meta.url));
const source = readFileSync(LAYOUT, 'utf8');

/** The memberKicked handler: from `memberKicked:` to the next handler. */
function kickedHandler(): string {
  const start = source.indexOf('memberKicked:');
  expect(start, 'memberKicked handler not found in MainLayout').toBeGreaterThan(-1);
  const end = source.indexOf('serverDeleted:', start);
  expect(end, 'end of memberKicked handler not found').toBeGreaterThan(start);
  return source.slice(start, end);
}

const locales = readdirSync(LOCALE_DIR).filter((f) => f.endsWith('.json')).map((file) => ({
  name: file.replace(/\.json$/, ''),
  server: (JSON.parse(readFileSync(LOCALE_DIR + file, 'utf8')) as { server: Record<string, unknown> }).server,
}));

describe('MainLayout tells a removed member they were banned', () => {
  it('no longer shows the hardcoded "kicked" sentence', () => {
    expect(kickedHandler()).not.toMatch(/kicked from the server/i);
  });

  it('names the space when the strip still has it, and falls back to a sentence without a name', () => {
    const handler = kickedHandler();
    // The name is read BEFORE handleMemberKicked removes the server from the store
    expect(handler.indexOf('servers.find')).toBeGreaterThan(-1);
    expect(handler.indexOf('servers.find')).toBeLessThan(handler.indexOf('handleMemberKicked('));
    expect(handler).toMatch(/i18n\.t\('server\.youWereRemovedAndBanned', \{ name: spaceName \}\)/);
    expect(handler).toMatch(/i18n\.t\('server\.youWereRemovedAndBannedUnknown'\)/);
  });

  it.each(locales.map((l) => [l.name, l.server] as const))('%s carries both sentences, the named one with {{name}}', (_name, server) => {
    expect(typeof server.youWereRemovedAndBanned).toBe('string');
    expect(server.youWereRemovedAndBanned as string).toContain('{{name}}');
    expect(typeof server.youWereRemovedAndBannedUnknown).toBe('string');
    expect((server.youWereRemovedAndBannedUnknown as string).length).toBeGreaterThan(0);
    expect(server.youWereRemovedAndBannedUnknown as string).not.toContain('{{');
  });
});
