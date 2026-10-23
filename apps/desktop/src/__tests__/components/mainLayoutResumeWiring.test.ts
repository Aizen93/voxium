// @vitest-environment node
// A source scan, like mainLayoutWebhookWiring.test.ts: MainLayout's effects
// are mounted by no component test, so the wiring is pinned on the source.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The resume handler (services/resume.ts) is what brings the app back after a
 * minimize: it reconnects the socket with a live token when it dropped and
 * refreshes the cheap slices when it did not. It is only as good as what
 * calls it — the window becoming visible again AND the network coming back,
 * both of which a laptop waking from sleep produces, in either order.
 */

const LAYOUT = fileURLToPath(new URL('../../components/layout/MainLayout.tsx', import.meta.url));
const source = readFileSync(LAYOUT, 'utf8');

/** The resume effect: from its visibility handler to the effect's closing. */
function resumeEffect(): string {
  const start = source.indexOf('const handleVisibilityChange = ');
  expect(start, 'the visibility handler not found in MainLayout').toBeGreaterThan(-1);
  const end = source.indexOf('}, []);', start);
  expect(end, 'end of the resume effect not found in MainLayout').toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('MainLayout wires the window coming back to handleAppResume', () => {
  it('imports handleAppResume from services/resume', () => {
    expect(source).toMatch(/import \{\s*handleAppResume\s*\} from '\.\.\/\.\.\/services\/resume';/);
  });

  it('calls it when the document becomes visible, and not while it is hidden', () => {
    const effect = resumeEffect();
    expect(effect).toMatch(/if \(document\.hidden\) return;\s*void handleAppResume\(\);/);
    expect(effect).toMatch(/document\.addEventListener\('visibilitychange', handleVisibilityChange\)/);
  });

  it('calls it when the network comes back (the window event)', () => {
    const effect = resumeEffect();
    expect(effect).toMatch(/const handleOnline = \(\) => \{ void handleAppResume\(\); \};/);
    expect(effect).toMatch(/window\.addEventListener\('online', handleOnline\)/);
  });

  it('removes both listeners on cleanup', () => {
    const effect = resumeEffect();
    expect(effect).toMatch(/document\.removeEventListener\('visibilitychange', handleVisibilityChange\)/);
    expect(effect).toMatch(/window\.removeEventListener\('online', handleOnline\)/);
  });

  it('fetches nothing itself any more: the handler decides what a resume needs', () => {
    const effect = resumeEffect();
    expect(effect).not.toMatch(/fetchConversations|fetchPeople|markChannelRead/);
  });
});
