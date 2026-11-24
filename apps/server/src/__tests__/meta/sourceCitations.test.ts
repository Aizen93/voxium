import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

// A source file states its reason where the reason applies. A comment, a test
// title or a script header never sends its reader to something the
// repository does not hold, because that reader cannot open it:
//   (a) a path under the git-ignored local documentation folder,
//   (b) a Markdown document that no tracked file bears the name of (the
//       names are taken from `git ls-files`, so nothing is listed here), and
//   (c) a section citation of a plan ("plan §4.2", "plan 4.2", "(plan D2)").
// Citing a tracked document by its path and section stays fine
// (`docs/e2e-dm-spec.md §9.1`, `Architecture.md`).

const ROOT = path.resolve(__dirname, '../../../../..');

const tracked: string[] = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  .split('\0')
  .filter(Boolean);

const trackedSet = new Set(tracked);

// What is scanned: every tracked text file that is source, test, script,
// workflow or configuration. Left out, and why:
//  - Markdown (the documents themselves; docsHygiene.test.ts guards them),
//  - apps/server/prisma/migrations (an applied migration's checksum covers
//    its comments),
//  - dotfiles such as .gitignore (a rule file must name what it ignores);
//    the environment templates (`.env.example` and the like) ARE scanned,
//  - lock files (generated),
//  - images, fonts, the WebAssembly binary and other non-text files,
//  - this file (its unit cases are made of the forms it refuses).
const SCANNED_EXTENSIONS = new Set([
  'ts', 'tsx', 'mts', 'cts', 'js', 'mjs', 'cjs', 'json', 'yml', 'yaml', 'sh', 'rs', 'toml', 'html', 'css', 'prisma',
  'nsh', 'example', 'txt', 'xml', 'plist',
]);
const SCANNED_NAMES = new Set(['Dockerfile', 'pre-commit', 'CODEOWNERS']);
const LOCK_FILES = new Set(['pnpm-lock.yaml', 'Cargo.lock']);
const MAX_BYTES = 4 * 1024 * 1024;
const THIS_FILE = 'apps/server/src/__tests__/meta/sourceCitations.test.ts';

function isScanned(file: string): boolean {
  if (file === THIS_FILE) return false;
  if (file.startsWith('apps/server/prisma/migrations/')) return false;
  const base = file.slice(file.lastIndexOf('/') + 1);
  if (base.startsWith('.') && !base.endsWith('.example')) return false;
  if (LOCK_FILES.has(base)) return false;
  if (SCANNED_NAMES.has(base)) return true;
  const dot = base.lastIndexOf('.');
  return dot > 0 && SCANNED_EXTENSIONS.has(base.slice(dot + 1));
}

// (a) The local documentation folder.
const LOCAL_DOCS = /docs\/local/;

// (b) A Markdown file name with the path written before it (the rule of
// docsHygiene.test.ts). The tail of a web address is somebody else's file.
const NAMED_DOCUMENT = /[A-Za-z0-9_.\-/]*[A-Za-z0-9_-]\.md\b/g;

// (c) A section citation of a plan: "plan §4.2", "infra plan §8", "plan 4.2",
// '(plan: "…")', '(plan D2)'. Ordinary uses of the word (the query plan, a
// plan to do something, a plan object in code) do not match: the word must be
// followed by a section sign or a section number, or open a parenthesis with a
// quoted "plan:" or a lettered item number.
const PLAN_CITATIONS = [/\bplan ?§/i, /\bplan \d+(?:\.\d+)*\b/i, /\(plan: ?["“]/, /\(plan [A-Z]\d/];

/** The Markdown documents a line names that the repository does not track. */
function untrackedDocumentsIn(line: string, isTracked: (name: string) => boolean = (n) => trackedSet.has(n)): string[] {
  const found: string[] = [];
  for (const match of line.matchAll(NAMED_DOCUMENT)) {
    const name = match[0];
    // The tail of a web address, or a relative link into the hosting site.
    if (name.startsWith('/') || name.startsWith('../')) continue;
    if (!isTracked(name)) found.push(name);
  }
  return found;
}

function citesLocalDocs(line: string): boolean {
  return LOCAL_DOCS.test(line);
}

function citesPlanSection(line: string): boolean {
  return PLAN_CITATIONS.some((re) => re.test(line));
}

function offences(line: string): string[] {
  const kinds: string[] = [];
  if (citesLocalDocs(line)) kinds.push('local docs path');
  const docs = untrackedDocumentsIn(line);
  if (docs.length > 0) kinds.push(`untracked Markdown ${docs.join(', ')}`);
  if (citesPlanSection(line)) kinds.push('plan section citation');
  return kinds;
}

// Lines that name one of these on purpose, with the number of lines found.
// The count found must equal the count listed.
const ALLOWED: Record<string, { lines: number; reason: string }> = {
  'apps/server/src/__tests__/meta/docsHygiene.test.ts': {
    lines: 3,
    reason: 'a comment saying the local folder is untracked, and the sample text of its own unit case',
  },
  'apps/desktop/src/__tests__/meta/architecturePaths.test.ts': {
    lines: 1,
    reason: 'the rule that Architecture.md cites nothing under the local folder',
  },
  'apps/server/src/__tests__/scripts/playwrightFlakySummary.test.ts': {
    lines: 2,
    reason: 'the name of an output file the script under test writes in a temporary directory, not a document',
  },
};

describe('source files cite nothing the repository does not hold', () => {
  const files = tracked.filter(isScanned).filter((f) => statSync(path.join(ROOT, f)).size <= MAX_BYTES);

  it('finds the files to scan', () => {
    expect(files).toContain('apps/server/src/utils/serverJoin.ts');
    expect(files).toContain('.github/workflows/ci.yml');
    expect(files).toContain('apps/server/prisma/schema.prisma');
    expect(files).toContain('.env.production.example');
    expect(files).toContain('apps/server/.env.example');
    expect(files).not.toContain('.gitignore');
    expect(files).not.toContain(THIS_FILE);
    expect(tracked).toContain(THIS_FILE);
    expect(files.some((f) => f.endsWith('.md'))).toBe(false);
    expect(files.some((f) => f.startsWith('apps/server/prisma/migrations/'))).toBe(false);
  });

  it('holds no line that points at a local document, an untracked Markdown file or a plan section', () => {
    const problems: string[] = [];
    const counts = new Map<string, number>();
    for (const file of files) {
      const lines = readFileSync(path.join(ROOT, file), 'utf8').split(/\r?\n/);
      lines.forEach((line, i) => {
        const kinds = offences(line);
        if (kinds.length === 0) return;
        if (ALLOWED[file]) {
          counts.set(file, (counts.get(file) ?? 0) + 1);
          return;
        }
        problems.push(`${file}:${i + 1} ${kinds.join('; ')}`);
      });
    }
    expect(problems).toEqual([]);
    for (const [file, { lines }] of Object.entries(ALLOWED)) {
      expect({ file, found: counts.get(file) ?? 0 }).toEqual({ file, found: lines });
    }
  });

  it('allows nothing that is not tracked', () => {
    for (const file of Object.keys(ALLOWED)) expect(trackedSet.has(file)).toBe(true);
  });
});

describe('the three checks', () => {
  const tracks = (names: string[]) => (n: string) => names.includes(n);

  it('(a) flags the local documentation folder', () => {
    expect(citesLocalDocs('// see docs/local/some-plan.html')).toBe(true);
    expect(citesLocalDocs(' * (docs/local/x, "Data model")')).toBe(true);
    expect(citesLocalDocs('// docs/e2e-dm-spec.md section 9.1')).toBe(false);
    expect(citesLocalDocs('// a local document')).toBe(false);
  });

  it('(b) flags a Markdown name no tracked file bears, and only that', () => {
    const t = tracks(['README.md', 'Architecture.md', 'docs/e2e-dm-spec.md']);
    expect(untrackedDocumentsIn('// see NOTES.md', t)).toEqual(['NOTES.md']);
    expect(untrackedDocumentsIn('// (OTHER.md "Section")', t)).toEqual(['OTHER.md']);
    expect(untrackedDocumentsIn('// docs/missing/guide.md and README.md', t)).toEqual(['docs/missing/guide.md']);
    expect(untrackedDocumentsIn('// README.md and Architecture.md', t)).toEqual([]);
    expect(untrackedDocumentsIn('// docs/e2e-dm-spec.md §9.1', t)).toEqual([]);
    expect(untrackedDocumentsIn('// https://example.com/project/blob/main/README.md', t)).toEqual([]);
    expect(untrackedDocumentsIn('const re = /*.md/; // any .md file', t)).toEqual([]);
  });

  it('(b) takes the tracked names from git, not from this file', () => {
    expect(trackedSet.has('README.md')).toBe(true);
    expect(untrackedDocumentsIn('// README.md and docs/e2e-dm-spec.md')).toEqual([]);
  });

  it('(c) flags a plan section citation', () => {
    expect(citesPlanSection('// born encrypted (plan §4.2)')).toBe(true);
    expect(citesPlanSection('// the plan§4')).toBe(true);
    expect(citesPlanSection('// see plan 4.2 for why')).toBe(true);
    expect(citesPlanSection('// Plan 4 says so')).toBe(true);
    expect(citesPlanSection('// every removal is a ban (plan: "kick is ban")')).toBe(true);
    expect(citesPlanSection('// the only mitigation (plan D2)')).toBe(true);
    expect(citesPlanSection('// the infra plan §8.6 needs it')).toBe(true);
  });

  it('(c) leaves ordinary uses of the word and tracked citations alone', () => {
    expect(citesPlanSection('// spec §9.1 and docs/e2e-dm-spec.md §12.3')).toBe(false);
    expect(citesPlanSection('// docs/e2e-always-on-plan.md §4.2')).toBe(false);
    expect(citesPlanSection('// the query plan shows an index scan')).toBe(false);
    expect(citesPlanSection('// we plan to read it twice')).toBe(false);
    expect(citesPlanSection('// (plan to retry) is not a citation')).toBe(false);
    expect(citesPlanSection('expect(plan.rules[0]).toBe(first);')).toBe(false);
    expect(citesPlanSection('const plan = planWrite(stored, sent);')).toBe(false);
    expect(citesPlanSection('// Architecture.md and README.md')).toBe(false);
  });

  it('each kind of line is reported by the scan itself', () => {
    expect(offences('// see docs/local/x.html')).toEqual(['local docs path']);
    expect(offences('// see NOT-A-TRACKED-DOCUMENT.md')).toEqual(['untracked Markdown NOT-A-TRACKED-DOCUMENT.md']);
    expect(offences('// born encrypted (plan §4.2)')).toEqual(['plan section citation']);
    expect(offences('// nothing to report here')).toEqual([]);
  });
});
