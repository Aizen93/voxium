// @vitest-environment node
// A source scan, like dmPlaintextGate.test.ts: no DOM, and jsdom does not give
// this module a file:// import.meta.url to resolve MainLayout against.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * A conversation whose other side's account was deleted, as MainLayout's
 * socket handlers see it: `dm:conversation:read_only` goes to the validating
 * handler (services/dmReadOnly.ts), nobody is shown typing there, and no ring
 * of it is shown. MainLayout's listener effect is mounted by no component
 * test, so the wiring is pinned on the source.
 */

const LAYOUT = fileURLToPath(new URL('../../components/layout/MainLayout.tsx', import.meta.url));
const source = readFileSync(LAYOUT, 'utf8');

/** The body of one handler in MainLayout's `handlers` object (dmPlaintextGate.test.ts's rule). */
function handlerBody(name: string): string {
  const start = source.indexOf(`      ${name}: `);
  expect(start, `${name} not found in MainLayout`).toBeGreaterThan(-1);
  const next = source.slice(start + 1).search(/\n {6}[a-zA-Z]+: (async )?\(/);
  expect(next, `end of ${name} not found in MainLayout`).toBeGreaterThan(-1);
  return source.slice(start, start + 1 + next);
}

/** MainLayout's `eventMap` table: from its declaration to the closing `];`. */
function eventTable(): string {
  const start = source.indexOf('const eventMap');
  expect(start, 'eventMap not found in MainLayout').toBeGreaterThan(-1);
  const end = source.indexOf('];', start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('MainLayout and read-only conversations', () => {
  it('imports the handler from services/dmReadOnly and registers ONE entry for the event', () => {
    expect(source).toMatch(/import \{ handleConversationReadOnly, standsAsDeletedNow \} from '\.\.\/\.\.\/services\/dmReadOnly';/);
    const table = eventTable();
    expect(table.match(/DM_CONVERSATION_READ_ONLY/g) ?? []).toHaveLength(1);
    expect(table).toMatch(/\[WS_EVENTS\.DM_CONVERSATION_READ_ONLY, handlers\.dmConversationReadOnly\]/);
  });

  it('the handler hands the untyped payload over as it came (the module validates it)', () => {
    const body = handlerBody('dmConversationReadOnly');
    expect(body).toMatch(/dmConversationReadOnly: \(data: unknown\) => \{/);
    expect(body).toMatch(/handleConversationReadOnly\(data\);/);
  });

  it('a pushed row of a conversation the list then holds read-only is dropped before any preview, count, sound or notification', () => {
    const body = handlerBody('dmMessageNew');
    const fetch = body.indexOf('await dmStore.fetchConversations();');
    const drop = body.indexOf('if (standsAsDeletedNow(message)) return;');
    expect(fetch).toBeGreaterThan(-1);
    // after the fetch that may say so, and after the session check that follows it
    expect(drop).toBeGreaterThan(body.indexOf('if (signedInUser() !== session) return;', fetch));
    for (const later of ['addMessage(', 'incrementDMUnread(', 'playMessageSound(', 'notify(']) {
      expect(body.indexOf(later), later).toBeGreaterThan(drop);
    }
  });

  it('nobody is shown typing on the other side of a read-only conversation', () => {
    const body = handlerBody('dmTypingStart');
    const guard = body.indexOf('if (isConversationReadOnly(conversationId)) return;');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(body.indexOf('setTypingUser('));
  });

  it('no ring of a read-only conversation is shown', () => {
    const body = handlerBody('dmVoiceOffer');
    const guard = body.indexOf('if (isConversationReadOnly(conversationId)) return;');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(body.indexOf('setIncomingCall('));
  });

  it('the global search names the other side through the shared rule, never the server\'s placeholder name', () => {
    expect(source).toMatch(/participantName=\{conv \? participantDisplayName\(conv, t\) : undefined\}/);
    expect(source).not.toMatch(/participantName=\{conv\?\.participant\.displayName\}/);
  });
});
