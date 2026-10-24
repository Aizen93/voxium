// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import {
  IP_RECORD_RETENTION_DAYS,
  ORPHAN_GRACE_DAYS,
  TRUSTED_DEVICE_TTL_DAYS,
  LIMITS,
  JOIN_REQUEST_PENDING_TTL_DAYS,
  JOIN_REQUEST_DECLINE_COOLDOWN_DAYS,
  E2E_LIMITS,
} from '@voxium/shared';
import { PrivacyContent } from '../../components/legal/PrivacyContent';
import { TermsContent } from '../../components/legal/TermsContent';
import { CookiePolicyPage } from '../../pages/CookiePolicyPage';

/**
 * The legal pages state facts the code implements, pinned to the code.
 *
 * Users accept the Terms and the Privacy Policy at signup, and the Cookie
 * Policy describes what the app writes on their device. A number typed into
 * one of them drifts the moment the constant it describes changes (the
 * Cookie Policy said tokens lasted "until logout" long after refresh tokens
 * had a fixed lifetime), so every number on these pages is read back here
 * from the constant it describes, and a number with no pin fails the suite.
 * The same goes for the storage keys the app writes and for the outside
 * services the pages disclose.
 *
 * The pages must also never describe our infrastructure: no product,
 * provider, host or port. They say "our servers" and "server logs".
 *
 * Node environment: the pages render with react-dom/server, and the
 * server-side values the desktop package cannot import are read from source.
 */

const SRC = join(__dirname, '..', '..');
const REPO = join(SRC, '..', '..', '..');
const SERVER_SRC = join(REPO, 'apps', 'server', 'src');
const DAY_MS = 24 * 60 * 60 * 1000;

function readServer(rel: string): string {
  return readFileSync(join(SERVER_SRC, rel), 'utf-8');
}

/** The first capture of `re` in `source`, as a number (`14_400` → 14400). */
function capture(source: string, re: RegExp, what: string): number {
  const match = re.exec(source);
  if (!match) throw new Error(`could not find ${what} — the pattern this test reads it with is stale`);
  return Number(match[1].replace(/_/g, ''));
}

// ─── Server-side values (not exported to the desktop package) ────────────────

const registrationHygiene = readServer('utils/registrationHygiene.ts');
const UNVERIFIED_ACCOUNT_TTL_DAYS = capture(
  registrationHygiene,
  /export const UNVERIFIED_ACCOUNT_TTL_DAYS = (\d+);/,
  'UNVERIFIED_ACCOUNT_TTL_DAYS in utils/registrationHygiene.ts',
);

const ANNOTATION_TTL_SECONDS = capture(
  readServer('utils/annotationState.ts'),
  /export const ANNOTATION_STATE_TTL_SECONDS = ([\d_]+);/,
  'ANNOTATION_STATE_TTL_SECONDS in utils/annotationState.ts',
);
const ANNOTATION_TTL_HOURS = ANNOTATION_TTL_SECONDS / 3600;

const authService = readServer('services/authService.ts');
/** generateTokens(): the defaults when JWT_EXPIRES_IN / JWT_REFRESH_EXPIRES_IN are unset. */
const ACCESS_TOKEN_MINUTES = capture(authService, /JWT_EXPIRES_IN \|\| '(\d+)m'/, 'the access-token default lifetime');
const REFRESH_REMEMBERED_DAYS = capture(authService, /JWT_REFRESH_EXPIRES_IN \|\| '(\d+)d'/, 'the "Remember me" refresh-token default lifetime');
const REFRESH_SESSION_HOURS = capture(
  authService,
  /JWT_REFRESH_EXPIRES_IN \|\| '\d+d'\)\s*:\s*'(\d+)h'/,
  'the refresh-token lifetime without "Remember me"',
);

const KEYSHARE_MAX_AGE_DAYS = E2E_LIMITS.KEYSHARE_MAX_AGE_MS / DAY_MS;

// ─── Rendering ───────────────────────────────────────────────────────────────

function decodeEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/** What a reader sees: inline tags vanish, every other tag separates words. */
function visibleText(html: string): string {
  return decodeEntities(
    html
      .replace(/<\/?(?:strong|em|a|span)\b[^>]*>/g, '')
      .replace(/<[^>]+>/g, ' '),
  ).replace(/\s+/g, ' ').trim();
}

function render(element: ReactElement) {
  const html = renderToStaticMarkup(element);
  const headings = Array.from(html.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/g), (m) => visibleText(m[1]));
  return { html, text: visibleText(html), headings };
}

type PageName = 'privacy' | 'terms' | 'cookies';

const pages: Record<PageName, ReturnType<typeof render>> = {
  privacy: render(createElement(PrivacyContent)),
  terms: render(createElement(TermsContent)),
  cookies: render(createElement(MemoryRouter, null, createElement(CookiePolicyPage))),
};
const pageNames = Object.keys(pages) as PageName[];

const LAST_UPDATED = 'Last updated: October 24, 2026';

/** Every number a page states, as the phrase that states it, with where the value comes from. */
const PINS: Record<PageName, Array<{ phrase: string; source: string }>> = {
  privacy: [
    { phrase: `never more than ${ANNOTATION_TTL_HOURS} hours after the last change`, source: 'ANNOTATION_STATE_TTL_SECONDS (server utils/annotationState.ts)' },
    { phrase: `deleted ${LIMITS.ATTACHMENT_RETENTION_DAYS} days after the message they were sent with`, source: 'LIMITS.ATTACHMENT_RETENTION_DAYS' },
    { phrase: `deleted after ${IP_RECORD_RETENTION_DAYS} days without activity from that address`, source: 'IP_RECORD_RETENTION_DAYS' },
    { phrase: `deleted ${UNVERIFIED_ACCOUNT_TTL_DAYS} days after registration`, source: 'UNVERIFIED_ACCOUNT_TTL_DAYS (server utils/registrationHygiene.ts)' },
    { phrase: `deleted ${JOIN_REQUEST_PENDING_TTL_DAYS} days after being sent`, source: 'JOIN_REQUEST_PENDING_TTL_DAYS' },
    { phrase: `kept for ${JOIN_REQUEST_DECLINE_COOLDOWN_DAYS} days, so the same server`, source: 'JOIN_REQUEST_DECLINE_COOLDOWN_DAYS' },
    { phrase: `Undelivered encryption key material is deleted after ${KEYSHARE_MAX_AGE_DAYS} days`, source: 'E2E_LIMITS.KEYSHARE_MAX_AGE_MS' },
    { phrase: `at least ${ORPHAN_GRACE_DAYS} days old`, source: 'ORPHAN_GRACE_DAYS' },
  ],
  terms: [
    // A legal decision, not a code constant: nothing in the code checks age.
    { phrase: 'at least 13 years old', source: 'the minimum age (no code constant)' },
  ],
  cookies: [
    { phrase: `${ACCESS_TOKEN_MINUTES} minutes, renewed automatically`, source: 'generateTokens() JWT_EXPIRES_IN default' },
    { phrase: `Up to ${REFRESH_REMEMBERED_DAYS} days with “Remember me”`, source: 'generateTokens() JWT_REFRESH_EXPIRES_IN default' },
    { phrase: `${REFRESH_SESSION_HOURS} hours without`, source: 'generateTokens() refresh lifetime without "Remember me"' },
    { phrase: `${TRUSTED_DEVICE_TTL_DAYS} days; kept when you sign out`, source: 'TRUSTED_DEVICE_TTL_DAYS' },
  ],
};

/** Statements the code proved false; none may come back. */
const KNOWN_FALSE = [
  'Until logout',
  'local storage for authentication',
  'never leave your device',
  'All stored data is anonymous',
  'Export your data',
  'solely for security',
  'server-side encryption at rest',
  'delete your account at any time',
  'promptly update it',
  'days after upload',
  'in shared servers',
];

/** Infrastructure the pages must never name: products, providers, tooling. */
const INFRASTRUCTURE_WORDS = [
  'redis', 'postgres', 'postgresql', 'prisma', 's3', 'minio', 'nginx', 'pm2', 'ovh', 'docker',
  'kubernetes', 'k8s', 'mediasoup', 'coturn', 'aws', 'amazon', 'cloudflare', 'hetzner', 'smtp',
  'geoip', 'pg_dump', 'logrotate', 'localhost',
];

describe('legal pages: dates and structure', () => {
  it.each(pageNames)('%s shows the date of the last revision', (name) => {
    expect(pages[name].text).toContain(LAST_UPDATED);
  });

  it.each(pageNames)('%s numbers its sections 1..n in order', (name) => {
    const numbers = pages[name].headings.map((h) => Number(/^(\d+)\. /.exec(h)?.[1]));
    expect(numbers.length).toBeGreaterThan(0);
    expect(numbers).toEqual(numbers.map((_, i) => i + 1));
  });
});

describe('legal pages state the numbers the code implements', () => {
  it('reads every server-side value as a whole number', () => {
    for (const value of [UNVERIFIED_ACCOUNT_TTL_DAYS, ANNOTATION_TTL_HOURS, ACCESS_TOKEN_MINUTES, REFRESH_REMEMBERED_DAYS, REFRESH_SESSION_HOURS, KEYSHARE_MAX_AGE_DAYS]) {
      expect(Number.isInteger(value) && value > 0, String(value)).toBe(true);
    }
  });

  it.each(pageNames)('%s states each pinned number from its constant', (name) => {
    for (const { phrase, source } of PINS[name]) {
      expect(pages[name].text, `${name}: "${phrase}" (${source})`).toContain(phrase);
    }
  });

  it.each(pageNames)('%s states no number that is not pinned here', (name) => {
    let rest = pages[name].text.replace(LAST_UPDATED, ' ');
    for (const heading of pages[name].headings) {
      rest = rest.replace(heading, heading.replace(/^\d+\. /, ''));
    }
    for (const { phrase } of PINS[name]) rest = rest.split(phrase).join(' ');
    const stray = rest.match(/\S*\d\S*/g) ?? [];
    expect(stray, `${name}: every number must be pinned to the constant it describes (add it to PINS)`).toEqual([]);
  });
});

describe('legal pages no longer make the statements the code contradicts', () => {
  it.each(pageNames)('%s carries none of the known-false phrases', (name) => {
    const text = pages[name].text.toLowerCase();
    for (const phrase of KNOWN_FALSE) {
      expect(text, `${name}: "${phrase}"`).not.toContain(phrase.toLowerCase());
    }
  });

  it.each(pageNames)('%s names no infrastructure component, provider, host or address', (name) => {
    const html = pages[name].html.toLowerCase();
    for (const word of INFRASTRUCTURE_WORDS) {
      expect(new RegExp(`\\b${word}\\b`).test(html), `${name} names "${word}"`).toBe(false);
    }
    expect(/\b\d{1,3}(?:\.\d{1,3}){3}\b/.test(html), `${name} contains an IPv4 address`).toBe(false);
  });

  it('the account-deletion conditions the pages state are the ones the server enforces', () => {
    // deleteOwnAccount(): password, then the TOTP code when enabled, then the owned-servers refusal
    expect(authService).toContain("throw new BadRequestError('Password is incorrect')");
    expect(authService).toContain("throw new BadRequestError('Two-factor authentication code is required')");
    expect(authService).toContain('throw new OwnedServersError(user.ownedServers)');
    for (const name of ['privacy', 'terms'] as const) {
      const text = pages[name].text.toLowerCase();
      expect(text, name).toContain('settings → security');
      expect(text, name).toContain('you confirm with your password, and with your two-factor code if it');
      expect(text, name).toContain('if you still own servers, transfer or delete them first');
    }
  });

  it('there is still no self-service export, nor a username or email change, as the pages say', () => {
    const routes = ['routes/auth.ts', 'routes/users.ts'].flatMap((file) =>
      Array.from(readServer(file).matchAll(/Router\.(?:get|post|put|patch|delete)\(\s*'([^']*)'/g), (m) => m[1]));
    expect(routes).toContain('/me/profile');
    const offending = routes.filter((path) => /export|username|email/i.test(path) && path !== '/verify-email');
    expect(offending, 'a new account route: update the Terms (section 2) and the Privacy Policy (Your Rights)').toEqual([]);
    expect(pages.privacy.text).toContain('the app has no download for it yet');
    expect(pages.terms.text).toContain('your username and email address cannot be changed from the app');
  });
});

describe('the outside services the pages disclose are the ones the app contacts', () => {
  it('discloses GitHub as the update source, and the updater still points only there', () => {
    const conf = JSON.parse(readFileSync(join(REPO, 'apps', 'desktop', 'src-tauri', 'tauri.conf.json'), 'utf-8')) as {
      plugins?: { updater?: { endpoints?: string[] } };
    };
    const endpoints = conf.plugins?.updater?.endpoints ?? [];
    expect(endpoints.length).toBeGreaterThan(0);
    for (const url of endpoints) expect(new URL(url).hostname).toBe('github.com');
    expect(pages.privacy.text).toContain('the desktop app asks GitHub');
    expect(pages.cookies.text).toContain('GitHub, to check for updates');
  });

  it('discloses the email delivery provider for account emails', () => {
    expect(pages.privacy.text).toContain('sent through an email delivery provider');
  });
});

describe('the Cookie Policy lists every storage key the app writes', () => {
  /** Keys the policy describes by name of the row rather than by key. */
  const DESCRIBED_BY_ROW: Record<string, string> = {
    voxium_access_token: 'Access token',
    voxium_refresh_token: 'Refresh token',
    voxium_trusted_device: 'Trusted-device token',
    voxium_e2e_pk_: 'Vault key',
  };

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) return entry === '__tests__' ? [] : sourceFiles(path);
      return /\.tsx?$/.test(entry) ? [path] : [];
    });
  }

  const keys = new Set<string>();
  for (const file of sourceFiles(SRC)) {
    for (const match of readFileSync(file, 'utf-8').matchAll(/['"`](voxium_[A-Za-z0-9_]+|vox:[A-Za-z]+:(?:[A-Za-z]+)?)/g)) {
      keys.add(match[1]);
    }
  }

  it('finds the keys it is meant to find (the scan is not vacuous)', () => {
    expect(keys).toContain('voxium_settings');
    expect(keys).toContain('voxium_access_token');
    expect(keys).toContain('vox:securePins:');
  });

  it.each([...keys].sort())('names %s', (key) => {
    const row = DESCRIBED_BY_ROW[key];
    expect(pages.cookies.text, `a new storage key: list "${key}" on the Cookie Policy`).toContain(row ?? key);
  });
});
