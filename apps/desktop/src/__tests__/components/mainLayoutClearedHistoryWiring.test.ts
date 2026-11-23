// @vitest-environment node
// A source scan, like mainLayoutReadOnlyWiring.test.ts: MainLayout's listener
// effect is mounted by no component test, so the wiring is pinned on the source.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * `dm:conversation:deleted { conversationId, clearedUntil? }` reaches every
 * device of the account that removed a conversation (#47): MainLayout checks
 * the payload at runtime (services/dmClearedHistory.ts) and hands it to the
 * store's removal, which applies the floor before anything else (the store's
 * own test). The behaviour of each step is tested where it lives.
 */

const LAYOUT = fileURLToPath(new URL('../../components/layout/MainLayout.tsx', import.meta.url));
const source = readFileSync(LAYOUT, 'utf8');

function handlerBody(name: string): string {
  const start = source.indexOf(`      ${name}: `);
  expect(start, `${name} not found in MainLayout`).toBeGreaterThan(-1);
  const next = source.slice(start + 1).search(/\n {6}[a-zA-Z]+: (async )?\(/);
  expect(next, `end of ${name} not found in MainLayout`).toBeGreaterThan(-1);
  return source.slice(start, start + 1 + next);
}

describe('MainLayout and a removed conversation', () => {
  it('registers ONE entry for the event', () => {
    const start = source.indexOf('const eventMap');
    const table = source.slice(start, source.indexOf('];', start));
    expect(table.match(/'dm:conversation:deleted'/g) ?? []).toHaveLength(1);
    expect(table).toMatch(/\['dm:conversation:deleted', handlers\.dmConversationDeleted\]/);
  });

  it('takes the payload untyped, checks it, and hands the id and the unchecked floor to the store\'s removal', () => {
    expect(source).toMatch(/import \{ readConversationRemovedNotice \} from '\.\.\/\.\.\/services\/dmClearedHistory';/);
    const body = handlerBody('dmConversationDeleted');
    expect(body).toMatch(/dmConversationDeleted: \(data: unknown\) => \{/);
    const check = body.indexOf('const notice = readConversationRemovedNotice(data);');
    const bail = body.indexOf('if (!notice) return;');
    const apply = body.indexOf("applyConversationRemoval(notice.conversationId, notice.clearedUntil, 'dm:conversation:deleted');");
    expect(check).toBeGreaterThan(-1);
    expect(bail).toBeGreaterThan(check);
    expect(apply).toBeGreaterThan(bail);
    // never the old drop alone, which ignored the floor
    expect(body).not.toMatch(/handleConversationDeleted\(/);
  });

  it('a new message (past the gate) of a conversation the store no longer holds forgets its removal before the list is fetched', () => {
    const body = handlerBody('dmMessageNew');
    const gate = body.indexOf('message = shown;');
    const forget = body.indexOf('dmStore.forgetRemoval(message.conversationId);');
    const fetch = body.indexOf('await dmStore.fetchConversationsFor(message.conversationId);');
    expect(gate).toBeGreaterThan(-1);
    expect(forget).toBeGreaterThan(gate);
    expect(fetch).toBeGreaterThan(forget);
  });
});
