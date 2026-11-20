// The admin dashboard and the web client can be served from one origin, where a
// browser-storage key both use is read, overwritten and cleared by both. This
// scan fails when a key the admin app uses equals a string the desktop app
// uses, and when the admin app touches browser storage anywhere but its token
// storage module (so the list that module exports stays complete).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ADMIN_STORAGE_KEYS } from '../../services/tokenStorage';

const ADMIN_SRC = path.resolve(import.meta.dirname, '../..');
const DESKTOP_SRC = path.resolve(import.meta.dirname, '../../../../desktop/src');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '__tests__' || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p));
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

const QUOTES = ["'", '"', String.fromCharCode(96)];

describe('browser-storage keys', () => {
  it('finds the sources it scans', () => {
    expect(sources(ADMIN_SRC).length).toBeGreaterThan(10);
    expect(sources(DESKTOP_SRC).length).toBeGreaterThan(50);
  });

  it('no admin key is a string the desktop app uses', () => {
    const desktop = sources(DESKTOP_SRC).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    for (const key of ADMIN_STORAGE_KEYS) {
      for (const q of QUOTES) {
        expect(desktop.includes(`${q}${key}${q}`), `${key} appears in the desktop app`).toBe(false);
      }
    }
  });

  it('the admin keys carry the admin prefix', () => {
    for (const key of ADMIN_STORAGE_KEYS) expect(key).toMatch(/^voxium_admin_/);
  });

  it('only the token storage module touches browser storage', () => {
    for (const f of sources(ADMIN_SRC)) {
      if (f.endsWith(path.join('services', 'tokenStorage.ts'))) continue;
      const text = fs.readFileSync(f, 'utf8');
      expect(/\b(?:localStorage|sessionStorage|indexedDB)\b|document\.cookie/.test(text), `${f} uses browser storage`).toBe(false);
    }
  });
});
