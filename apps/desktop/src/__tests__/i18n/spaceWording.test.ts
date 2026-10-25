// @vitest-environment node
// Pure filesystem check — no DOM, and jsdom does not give this module a
// file:// import.meta.url to resolve the locale directory against.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The product calls a community a SPACE in everything the user reads; the
 * code, the keys and the API keep "server" (owner, 2026-10-25). The only
 * English strings allowed to say "server" are the ones where it means a
 * machine. A placeholder named {{server}} is code, not a word.
 */

const LOCALE_DIR = fileURLToPath(new URL('../../i18n/locales/', import.meta.url));
const en = JSON.parse(readFileSync(`${LOCALE_DIR}en.json`, 'utf8')) as Record<string, unknown>;
const indexHtml = readFileSync(fileURLToPath(new URL('../../../index.html', import.meta.url)), 'utf8');

/** Where "server" means our machines, not a community. */
const MACHINE_SENSE = new Set([
  'serverErrors.voiceServerUnavailable', // the SFU
  'serverErrors.voiceServerRestarted',
  'landing.why.ownDataDesc', // "self-host or use our servers"
  'secureVoice.createHint', // "the server only ever relays sound"
  'secureChannel.pinnedDowngrade', // "the server now lists it"
  'webhooks.reveal.invalidUrl', // "the server sent a malformed URL"
]);

function leaves(node: unknown, prefix = ''): Array<[string, string]> {
  if (!node || typeof node !== 'object') return [];
  return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) =>
    typeof v === 'string' ? [[prefix + k, v] as [string, string]] : leaves(v, `${prefix}${k}.`));
}
const lookup = (key: string) => key.split('.').reduce<unknown>((n, p) => (n && typeof n === 'object' ? (n as Record<string, unknown>)[p] : undefined), en);
const saysServer = (text: string) => /\bservers?\b/i.test(text.replace(/\{\{\s*\w+\s*\}\}/g, ''));

describe('a community is a space in the English UI', () => {
  it('no English string calls a community a server', () => {
    const offenders = leaves(en).filter(([key, value]) => !MACHINE_SENSE.has(key) && saysServer(value));
    expect(offenders.map(([k, v]) => `${k} = ${v}`)).toEqual([]);
  });

  it('the machine-sense exceptions still exist and still say server (else drop them from the list)', () => {
    for (const key of MACHINE_SENSE) expect(String(lookup(key)), key).toMatch(/\bservers?\b/i);
  });

  it('the strings the e2e specs click by name say space', () => {
    expect(lookup('server.create.createTitle')).toBe('Create a Space');
    expect(lookup('server.create.createServer')).toBe('Create Space');
    expect(lookup('server.create.serverNamePlaceholder')).toBe('My Awesome Space');
    expect(lookup('server.createOrJoin')).toBe('Create or join a space');
    expect(lookup('serverSettings.title')).toBe('Space Settings');
    expect(lookup('channel.serverSettings')).toBe('Space Settings');
  });

  it('the landing page markup says space for communities too', () => {
    // "your server, your data" and "server resources" mean the machine
    const lines = indexHtml.split('\n').filter((l) => /\bservers?\b/i.test(l));
    const community = lines.filter((l) => !/your server, your data|server resources/.test(l));
    expect(community).toEqual([]);
  });
});
