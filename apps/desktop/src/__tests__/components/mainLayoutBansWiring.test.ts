// @vitest-environment node
// A source scan, like mainLayoutWebhookWiring.test.ts: MainLayout's listener
// effect is mounted by no component test.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const LAYOUT = fileURLToPath(new URL('../../components/layout/MainLayout.tsx', import.meta.url));
const source = readFileSync(LAYOUT, 'utf8');

function eventTable(): string {
  const start = source.indexOf('const eventMap');
  expect(start, 'eventMap not found in MainLayout').toBeGreaterThan(-1);
  const end = source.indexOf('];', start);
  expect(end, 'end of eventMap not found in MainLayout').toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('MainLayout wires server:bans_changed to the store', () => {
  it('the event table has ONE server:bans_changed entry, calling handleBansChanged', () => {
    const table = eventTable();
    expect(table.match(/'server:bans_changed'/g) ?? []).toHaveLength(1);
    expect(table).toMatch(/'server:bans_changed',[^\]]*handleBansChanged\(payload\)/);
  });

  it('the table is what both attach and detach iterate, so the handler is removed with the rest', () => {
    expect(source).toMatch(/for \(const \[event, handler\] of eventMap\) \{\s*emitter\.on\(event, handler\);/);
    expect(source).toMatch(/for \(const \[event, handler\] of eventMap\) \{\s*emitter\.off\(event, handler\);/);
  });
});
