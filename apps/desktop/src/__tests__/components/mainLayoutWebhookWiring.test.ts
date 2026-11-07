// @vitest-environment node
// A source scan, like dmPlaintextGate.test.ts: no DOM, and jsdom does not give
// this module a file:// import.meta.url to resolve MainLayout against.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * `message:bulk_deleted` (a webhook deleted with purge) reaches `channel:{id}`,
 * and the socket sits in every channel room the user can view while chatStore
 * holds ONE view's rows (shared with DMs). The handler acts on the channel on
 * screen only because MainLayout hands it `isViewingChannel` — the channel id
 * AND the server view. MainLayout's listener effect is mounted by no component
 * test, so the wiring is pinned on the source.
 */

const LAYOUT = fileURLToPath(new URL('../../components/layout/MainLayout.tsx', import.meta.url));
const source = readFileSync(LAYOUT, 'utf8');

/** MainLayout's `eventMap` table: from its declaration to the closing `];`. */
function eventTable(): string {
  const start = source.indexOf('const eventMap');
  expect(start, 'eventMap not found in MainLayout').toBeGreaterThan(-1);
  const end = source.indexOf('];', start);
  // never fall back to "the rest of the file": an entry elsewhere is not registered
  expect(end, 'end of eventMap not found in MainLayout').toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('MainLayout wires message:bulk_deleted to the guarded handler', () => {
  it('imports handleMessageBulkDeleted from services/webhookSocketHandlers', () => {
    expect(source).toMatch(
      /import \{[^}]*\bhandleMessageBulkDeleted\b[^}]*\} from '\.\.\/\.\.\/services\/webhookSocketHandlers';/,
    );
  });

  it('the event table has ONE message:bulk_deleted entry, calling handleMessageBulkDeleted(data, isViewingChannel)', () => {
    const table = eventTable();
    expect(table.match(/'message:bulk_deleted'/g) ?? []).toHaveLength(1);
    expect(table).toMatch(
      /\[\s*'message:bulk_deleted'\s*,\s*\(\s*data(\s*:\s*unknown)?\s*\)\s*=>\s*handleMessageBulkDeleted\(\s*data\s*,\s*isViewingChannel\s*\)\s*\]/,
    );
  });

  it('the table is what the listener effect attaches', () => {
    expect(source).toMatch(/for \(const \[event, handler\] of eventMap\) \{\s*emitter\.on\(event, handler\);/);
  });

  it('isViewingChannel is the VIEW guard: an active server AND the active channel', () => {
    const start = source.indexOf('const isViewingChannel = ');
    expect(start, 'isViewingChannel not found in MainLayout').toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf('};', start));
    expect(body).toMatch(/!!serverState\.activeServerId/);
    expect(body).toMatch(/channelId === serverState\.activeChannelId/);
  });
});

describe('MainLayout labels a webhook author in a desktop notification', () => {
  /** The server-channel message handler: from `messageNew:` to the next handler. */
  function messageNewHandler(): string {
    const start = source.indexOf('messageNew: async');
    expect(start, 'messageNew handler not found in MainLayout').toBeGreaterThan(-1);
    const end = source.indexOf('messageUpdate:', start);
    expect(end, 'end of messageNew not found in MainLayout').toBeGreaterThan(start);
    return source.slice(start, end);
  }

  it('imports notificationAuthorName from utils/notificationAuthor', () => {
    expect(source).toMatch(/import \{[^}]*\bnotificationAuthorName\b[^}]*\} from '\.\.\/\.\.\/utils\/notificationAuthor';/);
  });

  it('the notification author comes from notificationAuthorName(message.author, i18n.t), never the bare name', () => {
    const handler = messageNewHandler();
    expect(handler).toMatch(/const authorName = notificationAuthorName\(\s*message\.author\s*,\s*i18n\.t\s*\)/);
    expect(handler).not.toMatch(/message\.author\?\.displayName\s*\|\|/);
    // and that name is what both the title and the body print
    expect(handler).toMatch(/notify\(title, `\$\{authorName\}: \$\{body\}`/);
  });
});
