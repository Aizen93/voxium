import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Guards on the tracked Markdown documents: no hidden characters, no pointer
// in CONTEXT.md to a file the repository does not hold, and no Markdown
// document named that a reader of the repository cannot open. A control byte
// made tools treat docs/e2e-dm-spec.md as binary, and an invisible word
// joiner sat inside a formula nobody could see.

const ROOT = path.resolve(__dirname, '../../../../..');

const tracked: string[] = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  .split('\0')
  .filter(Boolean);

const trackedSet = new Set(tracked);

/** Markdown at the repository root and under docs/ (docs/local is untracked). */
const markdownFiles = tracked.filter((f) => f.endsWith('.md') && (!f.includes('/') || f.startsWith('docs/')));

// C0 controls except tab (0x09), LF (0x0a) and CR (0x0d).
// eslint-disable-next-line no-control-regex
const CONTROL_BYTE = /[\x00-\x08\x0b\x0c\x0e-\x1f]/;
// Word joiner, zero-width space, non-joiner, joiner, byte-order mark.
const INVISIBLE = /[⁠​‌‍﻿]/;

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

function codePoint(ch: string): string {
  return `U+${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;
}

// A Markdown file name with the path written before it.
const NAMED_DOCUMENT = /[A-Za-z0-9_.\-/]*[A-Za-z0-9_-]\.md\b/g;

/** The Markdown documents a text names that the repository does not track. */
function untrackedDocuments(text: string): { name: string; index: number }[] {
  const found: { name: string; index: number }[] = [];
  for (const match of text.matchAll(NAMED_DOCUMENT)) {
    const name = match[0];
    // The tail of a web address ("//host/…/README.md") is not ours to hold.
    if (name.startsWith('//')) continue;
    if (!trackedSet.has(name)) found.push({ name, index: match.index });
  }
  return found;
}

describe('tracked Markdown documents', () => {
  it('finds the documents to scan', () => {
    expect(markdownFiles).toContain('README.md');
    expect(markdownFiles).toContain('docs/e2e-dm-spec.md');
  });

  it('carry no control byte and no invisible formatting character', () => {
    const problems: string[] = [];
    for (const file of markdownFiles) {
      const text = readFileSync(path.join(ROOT, file), 'utf8');
      const control = CONTROL_BYTE.exec(text);
      if (control) problems.push(`${file}:${lineOf(text, control.index)} control byte ${codePoint(control[0])}`);
      const invisible = INVISIBLE.exec(text);
      if (invisible) problems.push(`${file}:${lineOf(text, invisible.index)} invisible character ${codePoint(invisible[0])}`);
    }
    expect(problems).toEqual([]);
  });

  // Every Markdown document one of them names is one the repository tracks:
  // a document kept out of it (.gitignore) is a pointer its reader cannot
  // follow. A name is taken as written, with the path it carries; the tail of
  // a web address is somebody else's document and is left alone.
  it('name no Markdown document the repository does not track', () => {
    const problems: string[] = [];
    for (const file of markdownFiles) {
      const text = readFileSync(path.join(ROOT, file), 'utf8');
      for (const { name, index } of untrackedDocuments(text)) {
        problems.push(`${file}:${lineOf(text, index)} ${name}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('tells a tracked document from one that is not, and leaves web addresses alone', () => {
    const sample = [
      'See CONTRIBUTING.md and `docs/e2e-dm-spec.md`.',
      'Read NOT-IN-THE-REPOSITORY.md (the "Updates" part) and docs/missing/plan.md.',
      'Upstream: https://example.com/project/blob/main/README.md',
      'A tracked `.md` file, or any *.md file.',
    ].join('\n');
    expect(untrackedDocuments(sample).map((d) => d.name)).toEqual(['NOT-IN-THE-REPOSITORY.md', 'docs/missing/plan.md']);
  });
});

describe('E2E spec version pin', () => {
  it('states the exact vodozemac pin Cargo.toml holds', () => {
    const cargo = readFileSync(path.join(ROOT, 'packages/crypto-engine/Cargo.toml'), 'utf8');
    const pin = /^vodozemac\s*=\s*"=(\d+\.\d+\.\d+)"/m.exec(cargo);
    expect(pin).not.toBeNull();
    const spec = readFileSync(path.join(ROOT, 'docs/e2e-dm-spec.md'), 'utf8');
    const stated = [...spec.matchAll(/=(\d+\.\d+\.\d+)/g)].map((m) => m[1]);
    expect(stated.length).toBeGreaterThan(0);
    expect(stated.filter((v) => v !== pin![1])).toEqual([]);
  });
});

describe('CONTEXT.md pointers', () => {
  // A backticked token with a slash that ends in a source or document
  // extension and holds nothing a glob, a placeholder or an example would.
  const PATH_TOKEN = /`([A-Za-z0-9_.\-/]+\/[A-Za-z0-9_.\-]+\.(?:ts|tsx|rs|md|json|ya?ml|mjs|cjs|sh|prisma|html))`/g;

  it('names only files the repository tracks', () => {
    const text = readFileSync(path.join(ROOT, 'CONTEXT.md'), 'utf8');
    const missing = new Set<string>();
    for (const match of text.matchAll(PATH_TOKEN)) {
      if (!trackedSet.has(match[1])) missing.add(match[1]);
    }
    expect([...missing]).toEqual([]);
  });
});
