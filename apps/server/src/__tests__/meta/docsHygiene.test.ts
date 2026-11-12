import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Guards on the tracked Markdown documents: no hidden characters, and no
// pointer in CONTEXT.md to a file the repository does not hold. A control
// byte made tools treat docs/e2e-dm-spec.md as binary, and an invisible
// word joiner sat inside a formula nobody could see.

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
