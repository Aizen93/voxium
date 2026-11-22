// @vitest-environment node
// A catch that says nothing hides the failure it caught. This scans the
// desktop sources (tests excluded) for:
//   covered:     a `catch` block that is empty or holds only comments, in
//                every spelling (with or without a binding, one line or
//                several), and an arrow handed to `.catch(...)` whose body is
//                empty, `undefined`, `null` or `void 0`;
//   NOT covered: `.catch(someFunction)` and a catch that only returns or
//                continues; those need a reader, not a pattern.
// Comments and the contents of strings, templates and regular expressions
// are ignored. The few silent ones that stay are listed with the number of
// them in each file and the reason; the count found must equal the count
// listed, so a new silent catch in a listed file fails too.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { findSilentCatches } from '../helpers/silentCatchScan';

const SRC = join(__dirname, '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== '__tests__') walk(p, out); }
    else if (/\.tsx?$/.test(entry.name)) out.push(p);
  }
  return out;
}

const SILENT_ON_PURPOSE: Array<{ file: string; count: number; reason: string }> = [
  { file: 'components/auth/RegisterCodeStep.tsx', count: 2, reason: 'the store holds and shows the error' },
  { file: 'pages/LoginPage.tsx', count: 2, reason: 'the store holds and shows the error' },
  { file: 'pages/RegisterPage.tsx', count: 1, reason: 'the store holds and shows the error' },
  { file: 'utils/maskStyles.ts', count: 1, reason: 'inside a handler that already logged; the black box below is what matters' },
  { file: 'services/tokenStorage.ts', count: 2, reason: 'a decode failure is reported on the line right below the catch' },
  { file: 'services/e2e/e2eService.ts', count: 1, reason: 'the serial queue keeps going; the run itself is reported to its caller' },
];

describe('desktop sources: no silent catches outside the listed ones', () => {
  const found = new Map<string, number>();
  for (const file of walk(SRC)) {
    const n = findSilentCatches(readFileSync(file, 'utf8')).length;
    if (n > 0) found.set(relative(SRC, file).replace(/\\/g, '/'), n);
  }

  it('finds exactly the listed ones, file by file and count by count', () => {
    const expected = new Map(SILENT_ON_PURPOSE.map((e) => [e.file, e.count]));
    expect(Object.fromEntries([...found].sort())).toEqual(Object.fromEntries([...expected].sort()));
  });

  it('lists each file once, with a reason', () => {
    expect(new Set(SILENT_ON_PURPOSE.map((e) => e.file)).size).toBe(SILENT_ON_PURPOSE.length);
    for (const e of SILENT_ON_PURPOSE) expect(e.reason.length).toBeGreaterThan(10);
  });
});

describe('the scanner itself, on in-memory sources', () => {
  const count = (src: string) => findSilentCatches(src).length;

  it.each([
    ['catch {}', 'try { x(); } catch {}'],
    ['catch (e) {}', 'try { x(); } catch (e) {}'],
    ['an empty multi-line catch', 'try { x(); } catch {\n}'],
    ['a comment-only multi-line catch with a binding', 'try { x(); } catch (_err) {\n  // ignore\n}'],
    ['a block-comment-only catch', 'try { x(); } catch { /* ignore */ }'],
    ['.catch(() => {})', 'p.catch(() => {});'],
    ['.catch with a parameter and an empty body', 'p.catch((_e) => {});'],
    ['.catch(() => null)', 'p.catch(() => null);'],
    ['.catch(() => undefined)', 'p.catch(() => undefined);'],
    ['.catch(() => void 0)', 'p.catch(() => void 0);'],
    ['.catch(e => {})', 'p.catch(e => {});'],
    ['.catch(async () => {})', 'p.catch(async () => {});'],
    ['an empty catch after a template literal with an expression', 'const a = `${f({ b: 1 })} x`; try { x(); } catch {}'],
  ])('finds %s', (_name, src) => {
    expect(count(src)).toBe(1);
  });

  it.each([
    ['a catch that logs', 'try { x(); } catch (e) { console.warn(e); }'],
    ['a catch that only returns', 'function f() { try { x(); } catch { return null; } }'],
    ['.catch(identifier)', 'p.catch(noop);'],
    ['.catch with a real handler', 'p.catch((e) => console.warn(e));'],
    ['.catch(() => ({}))', 'p.catch(() => ({}));'],
    ['an identifier that contains catch', 'const catcher = { catch: 1 }; doCatch(); x.catchAll(() => {});'],
  ])('does not find %s', (_name, src) => {
    expect(count(src)).toBe(0);
  });

  it('ignores a pattern inside a string, a template or a comment, and still finds a real one beside it', () => {
    const src = [
      'const a = "catch { // x }";',
      "const b = 'p.catch(() => {})';",
      'const c = `try {} catch {} ${"catch {}"}`;',
      '// see .catch(() => {}) and catch {}',
      '/* catch (e) {} */',
      'const d = /catch {}/;',
      'try { x(); } catch {}',
    ].join('\n');
    expect(count(src)).toBe(1);
    expect(count(src.replace('try { x(); } catch {}', ''))).toBe(0);
  });

  it('treats a body of only whitespace and comments as empty', () => {
    expect(count('try { x(); } catch {\n  // one\n  /* two */\n}')).toBe(1);
  });

  it('a count mismatch with the list fails the comparison the suite makes', () => {
    const listed = new Map([['a.ts', 1]]);
    const foundNow = new Map([['a.ts', count('try { x(); } catch {}\ntry { y(); } catch {}')]]);
    expect(Object.fromEntries(foundNow)).not.toEqual(Object.fromEntries(listed));
    const none = new Map<string, number>();
    expect(Object.fromEntries(none)).not.toEqual(Object.fromEntries(listed));
  });
});
