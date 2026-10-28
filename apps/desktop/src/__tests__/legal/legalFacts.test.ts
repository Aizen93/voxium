// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  IP_RECORD_RETENTION_DAYS,
  ORPHAN_GRACE_DAYS,
  TRUSTED_DEVICE_TTL_DAYS,
  LIMITS,
  JOIN_REQUEST_PENDING_TTL_DAYS,
  JOIN_REQUEST_DECLINE_COOLDOWN_DAYS,
  E2E_LIMITS,
  MINIMUM_AGE,
} from '@voxium/shared';
import { LEGAL_LANGUAGES, type LegalLanguage } from '../../components/legal/legalLanguage';
import { LEGAL_OPERATOR } from '../../components/legal/operator';
import { PRIVACY_CONTENT } from '../../components/legal/PrivacyContent';
import { TERMS_CONTENT } from '../../components/legal/TermsContent';
import { COOKIE_POLICY_CONTENT } from '../../components/legal/CookiePolicyContent';

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
 * Every document exists in English and in French (components/legal/*.en.tsx,
 * *.fr.tsx), and both are checked here alike: each pin, each phrase the code
 * backs, is written once per language, next to each other, so a constant that
 * changes is followed in both. The French must also keep the English's shape
 * (same sections, list items and table rows: a line added to one language
 * only fails) and French spacing.
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
    .replace(/&nbsp;/g, String.fromCharCode(0x00a0))
    .replace(/&amp;/g, '&');
}

/** Inline tags vanish, every other tag separates words; no-break spaces are kept. */
function rawText(html: string): string {
  return decodeEntities(
    html
      .replace(/<\/?(?:strong|em|a|span)\b[^>]*>/g, '')
      .replace(/<[^>]+>/g, '\n'),
  );
}

/** What a reader sees, with every run of spaces (no-break ones included) made one plain space. */
function visibleText(html: string): string {
  return rawText(html).replace(/\s+/g, ' ').trim();
}

function render(Document: ComponentType) {
  const html = renderToStaticMarkup(createElement(Document));
  const headings = Array.from(html.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/g), (m) => visibleText(m[1]));
  return { html, text: visibleText(html), headings };
}

type PageName = 'privacy' | 'terms' | 'cookies';
type Rendered = ReturnType<typeof render>;
/** One string per document language, written side by side. */
type PerLanguage = Record<LegalLanguage, string>;

/** What each dispatcher can render, per language: the documents users are actually shown. */
const DOCUMENTS: Record<PageName, Record<LegalLanguage, ComponentType>> = {
  privacy: PRIVACY_CONTENT,
  terms: TERMS_CONTENT,
  cookies: COOKIE_POLICY_CONTENT,
};
const pageNames = Object.keys(DOCUMENTS) as PageName[];

const pages = Object.fromEntries(pageNames.map((name) => [
  name,
  Object.fromEntries(LEGAL_LANGUAGES.map((lang) => [lang, render(DOCUMENTS[name][lang])])),
])) as Record<PageName, Record<LegalLanguage, Rendered>>;

/** Every (document, language) pair, for it.each. */
const cases = pageNames.flatMap((name) => LEGAL_LANGUAGES.map((lang) => [name, lang] as const));

const LAST_UPDATED: PerLanguage = {
  en: 'Last updated: October 25, 2026',
  fr: 'Dernière mise à jour : 25 octobre 2026',
};

/**
 * The change-notice promise (operator.ts), as the Terms and the Privacy Policy
 * state it: in the app, the only channel the Service has for it (announcements;
 * the only account e-mails are address verification and password reset).
 */
const CHANGE_NOTICE: { source: string } & PerLanguage = {
  source: 'LEGAL_OPERATOR.changeNoticeDays (components/legal/operator.ts)',
  en: `at least ${LEGAL_OPERATOR.changeNoticeDays} days' notice in the app before it takes effect`,
  fr: `nous vous en informons dans l’application au moins ${LEGAL_OPERATOR.changeNoticeDays} jours avant son entrée en vigueur`,
};

/** Every number a page states, as the phrase that states it in each language, with where the value comes from. */
const PINS: Record<PageName, Array<{ source: string } & PerLanguage>> = {
  privacy: [
    {
      source: 'ANNOTATION_STATE_TTL_SECONDS (server utils/annotationState.ts)',
      en: `never more than ${ANNOTATION_TTL_HOURS} hours after the last change`,
      fr: `jamais plus de ${ANNOTATION_TTL_HOURS} heures après la dernière modification`,
    },
    {
      source: 'LIMITS.ATTACHMENT_RETENTION_DAYS',
      en: `deleted ${LIMITS.ATTACHMENT_RETENTION_DAYS} days after the message they were sent with`,
      fr: `supprimées ${LIMITS.ATTACHMENT_RETENTION_DAYS} jours après le message avec lequel elles ont été envoyées`,
    },
    {
      source: 'IP_RECORD_RETENTION_DAYS',
      en: `deleted after ${IP_RECORD_RETENTION_DAYS} days without activity from that address`,
      fr: `supprimées après ${IP_RECORD_RETENTION_DAYS} jours sans activité depuis cette adresse`,
    },
    {
      source: 'UNVERIFIED_ACCOUNT_TTL_DAYS (server utils/registrationHygiene.ts)',
      en: `deleted ${UNVERIFIED_ACCOUNT_TTL_DAYS} days after registration`,
      fr: `supprimés ${UNVERIFIED_ACCOUNT_TTL_DAYS} jours après l’inscription`,
    },
    {
      source: 'JOIN_REQUEST_PENDING_TTL_DAYS',
      en: `deleted ${JOIN_REQUEST_PENDING_TTL_DAYS} days after being sent`,
      fr: `supprimées ${JOIN_REQUEST_PENDING_TTL_DAYS} jours après leur envoi`,
    },
    {
      source: 'JOIN_REQUEST_DECLINE_COOLDOWN_DAYS',
      en: `kept for ${JOIN_REQUEST_DECLINE_COOLDOWN_DAYS} days, so the same space`,
      fr: `conservée ${JOIN_REQUEST_DECLINE_COOLDOWN_DAYS} jours, afin que le même espace`,
    },
    {
      source: 'E2E_LIMITS.KEYSHARE_MAX_AGE_MS',
      en: `Undelivered encryption key material is deleted after ${KEYSHARE_MAX_AGE_DAYS} days`,
      fr: `Les éléments de clé de chiffrement non remis sont supprimés après ${KEYSHARE_MAX_AGE_DAYS} jours`,
    },
    {
      source: 'ORPHAN_GRACE_DAYS',
      en: `at least ${ORPHAN_GRACE_DAYS} days old`,
      fr: `datent d’au moins ${ORPHAN_GRACE_DAYS} jours`,
    },
    {
      source: 'MINIMUM_AGE',
      en: `not intended for anyone under ${MINIMUM_AGE}, and we do not knowingly collect data from them.`,
      fr: `ne s’adresse pas aux personnes de moins de ${MINIMUM_AGE} ans et nous ne collectons pas sciemment de données auprès d’elles.`,
    },
    CHANGE_NOTICE,
  ],
  terms: [
    // A legal decision (nothing in the code checks age), kept in one constant both documents read
    { source: 'MINIMUM_AGE', en: `at least ${MINIMUM_AGE} years old`, fr: `avoir au moins ${MINIMUM_AGE} ans` },
    CHANGE_NOTICE,
  ],
  cookies: [
    {
      source: 'generateTokens() JWT_EXPIRES_IN default',
      en: `${ACCESS_TOKEN_MINUTES} minutes, renewed automatically`,
      fr: `${ACCESS_TOKEN_MINUTES} minutes, renouvelé automatiquement`,
    },
    {
      source: 'generateTokens() JWT_REFRESH_EXPIRES_IN default',
      en: `Up to ${REFRESH_REMEMBERED_DAYS} days with “Remember me”`,
      fr: `Jusqu’à ${REFRESH_REMEMBERED_DAYS} jours avec « Se souvenir de moi »`,
    },
    {
      source: 'generateTokens() refresh lifetime without "Remember me"',
      en: `${REFRESH_SESSION_HOURS} hours without`,
      fr: `${REFRESH_SESSION_HOURS} heures sans`,
    },
    {
      source: 'TRUSTED_DEVICE_TTL_DAYS',
      en: `${TRUSTED_DEVICE_TTL_DAYS} days; kept when you sign out`,
      fr: `${TRUSTED_DEVICE_TTL_DAYS} jours ; conservé lorsque vous vous déconnectez`,
    },
  ],
};

/** Statements the code proved false; none may come back, in either language. */
const KNOWN_FALSE: Record<LegalLanguage, string[]> = {
  en: [
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
    'in shared spaces', // the same false claim under the product's current word
    // change notices: the only account e-mails are address verification and password reset
    'by email to your account address',
    'notices of changes to these documents',
  ],
  // The same statements, as a French translation would make them
  fr: [
    'jusqu’à la déconnexion',
    'stockage local pour l’authentification',
    'ne quittent jamais votre appareil',
    'toutes les données stockées sont anonymes',
    'exporter vos données',
    'uniquement à des fins de sécurité',
    'chiffrement côté serveur au repos',
    'supprimer votre compte à tout moment',
    'la mettre à jour sans délai',
    'jours après le téléversement',
    'jours après l’envoi du fichier',
    'dans les serveurs partagés',
    'dans les espaces partagés',
    'par e-mail à l’adresse de votre compte',
    'avis de modification des présents documents',
  ],
};

/**
 * Infrastructure the pages must never name: products, providers, tooling.
 * Product names are spelled alike in English and French; the hosting and
 * e-mail providers of the French market are listed too, since a French text
 * is the one most tempted to name them.
 */
const INFRASTRUCTURE_WORDS = [
  'redis', 'postgres', 'postgresql', 'prisma', 's3', 'minio', 'nginx', 'pm2', 'ovh', 'docker',
  'kubernetes', 'k8s', 'mediasoup', 'coturn', 'aws', 'amazon', 'cloudflare', 'hetzner', 'smtp',
  'geoip', 'pg_dump', 'logrotate', 'localhost',
  'scaleway', 'gandi', 'infomaniak', 'brevo', 'sendinblue', 'mailjet',
];

describe('legal pages: dates and structure', () => {
  it.each(cases)('%s (%s) shows the date of the last revision', (name, lang) => {
    expect(pages[name][lang].text).toContain(LAST_UPDATED[lang]);
  });

  it.each(cases)('%s (%s) numbers its sections 1..n in order', (name, lang) => {
    const numbers = pages[name][lang].headings.map((h) => Number(/^(\d+)\. /.exec(h)?.[1]));
    expect(numbers.length).toBeGreaterThan(0);
    expect(numbers).toEqual(numbers.map((_, i) => i + 1));
  });
});

describe('legal pages state the numbers the code implements', () => {
  it('reads every server-side value as a whole number', () => {
    for (const value of [UNVERIFIED_ACCOUNT_TTL_DAYS, ANNOTATION_TTL_HOURS, ACCESS_TOKEN_MINUTES, REFRESH_REMEMBERED_DAYS, REFRESH_SESSION_HOURS, KEYSHARE_MAX_AGE_DAYS, MINIMUM_AGE, LEGAL_OPERATOR.changeNoticeDays]) {
      expect(Number.isInteger(value) && value > 0, String(value)).toBe(true);
    }
  });

  it.each(cases)('%s (%s) states each pinned number from its constant', (name, lang) => {
    for (const pin of PINS[name]) {
      expect(pages[name][lang].text, `${name} (${lang}): "${pin[lang]}" (${pin.source})`).toContain(pin[lang]);
    }
  });

  it.each(cases)('%s (%s) states no number that is not pinned here', (name, lang) => {
    const page = pages[name][lang];
    let rest = page.text.replace(LAST_UPDATED[lang], ' ');
    for (const heading of page.headings) {
      rest = rest.replace(heading, heading.replace(/^\d+\. /, ''));
    }
    for (const pin of PINS[name]) rest = rest.split(pin[lang]).join(' ');
    const stray = rest.match(/\S*\d\S*/g) ?? [];
    expect(stray, `${name} (${lang}): every number must be pinned to the constant it describes (add it to PINS)`).toEqual([]);
  });
});

describe('legal pages no longer make the statements the code contradicts', () => {
  it.each(cases)('%s (%s) carries none of the known-false phrases', (name, lang) => {
    const text = pages[name][lang].text.toLowerCase();
    for (const phrase of KNOWN_FALSE[lang]) {
      expect(text, `${name} (${lang}): "${phrase}"`).not.toContain(phrase.toLowerCase());
    }
  });

  it.each(cases)('%s (%s) names no infrastructure component, provider, host or address', (name, lang) => {
    const html = pages[name][lang].html.toLowerCase();
    for (const word of INFRASTRUCTURE_WORDS) {
      expect(new RegExp(`\\b${word}\\b`).test(html), `${name} (${lang}) names "${word}"`).toBe(false);
    }
    expect(/\b\d{1,3}(?:\.\d{1,3}){3}\b/.test(html), `${name} (${lang}) contains an IPv4 address`).toBe(false);
  });

  /** deleteOwnAccount(): where to find it, then password + TOTP, then the owned-servers refusal. */
  const DELETION_CONDITIONS: PerLanguage[] = [
    { en: 'settings → security', fr: 'paramètres → sécurité' },
    {
      en: 'you confirm with your password, and with your two-factor code if it',
      fr: 'vous confirmez avec votre mot de passe, et avec votre code d’authentification à deux facteurs s’il',
    },
    {
      en: 'if you still own spaces, transfer or delete them first',
      fr: 'si vous possédez encore des espaces, transférez-les ou supprimez-les d’abord',
    },
  ];

  it.each(LEGAL_LANGUAGES)('the account-deletion conditions the pages state are the ones the server enforces (%s)', (lang) => {
    // deleteOwnAccount(): password, then the TOTP code when enabled, then the owned-servers refusal
    expect(authService).toContain("throw new BadRequestError('Password is incorrect')");
    expect(authService).toContain("throw new BadRequestError('Two-factor authentication code is required')");
    expect(authService).toContain('throw new OwnedServersError(user.ownedServers)');
    for (const name of ['privacy', 'terms'] as const) {
      const text = pages[name][lang].text.toLowerCase();
      for (const condition of DELETION_CONDITIONS) expect(text, `${name} (${lang})`).toContain(condition[lang]);
    }
  });

  const NO_EXPORT: PerLanguage = {
    en: 'the app has no download for it yet',
    fr: 'l’application ne propose pas encore de téléchargement',
  };
  const NO_ACCOUNT_CHANGE: PerLanguage = {
    en: 'your username and email address cannot be changed from the app',
    fr: 'votre nom d’utilisateur et votre adresse e-mail ne peuvent pas être modifiés depuis l’application',
  };

  it.each(LEGAL_LANGUAGES)('there is still no self-service export, nor a username or email change, as the pages say (%s)', (lang) => {
    const routes = ['routes/auth.ts', 'routes/users.ts'].flatMap((file) =>
      Array.from(readServer(file).matchAll(/Router\.(?:get|post|put|patch|delete)\(\s*'([^']*)'/g), (m) => m[1]));
    expect(routes).toContain('/me/profile');
    const offending = routes.filter((path) => /export|username|email/i.test(path) && path !== '/verify-email');
    expect(offending, 'a new account route: update the Terms (section 2) and the Privacy Policy (Your Rights)').toEqual([]);
    expect(pages.privacy[lang].text).toContain(NO_EXPORT[lang]);
    expect(pages.terms[lang].text).toContain(NO_ACCOUNT_CHANGE[lang]);
  });
});

describe('the outside services the pages disclose are the ones the app contacts', () => {
  const ASKS_GITHUB: PerLanguage = { en: 'the desktop app asks GitHub', fr: 'l’application de bureau demande à GitHub' };
  const GITHUB_ONLY: PerLanguage = { en: 'GitHub, to check for updates', fr: 'GitHub, pour vérifier les mises à jour' };
  const EMAIL_PROVIDER: PerLanguage = {
    en: 'sent through an email delivery provider',
    fr: 'envoyés par l’intermédiaire d’un prestataire d’envoi d’e-mails',
  };

  it.each(LEGAL_LANGUAGES)('discloses GitHub as the update source, and the updater still points only there (%s)', (lang) => {
    const conf = JSON.parse(readFileSync(join(REPO, 'apps', 'desktop', 'src-tauri', 'tauri.conf.json'), 'utf-8')) as {
      plugins?: { updater?: { endpoints?: string[] } };
    };
    const endpoints = conf.plugins?.updater?.endpoints ?? [];
    expect(endpoints.length).toBeGreaterThan(0);
    for (const url of endpoints) expect(new URL(url).hostname).toBe('github.com');
    expect(pages.privacy[lang].text).toContain(ASKS_GITHUB[lang]);
    expect(pages.cookies[lang].text).toContain(GITHUB_ONLY[lang]);
  });

  it.each(LEGAL_LANGUAGES)('discloses the email delivery provider for account emails (%s)', (lang) => {
    expect(pages.privacy[lang].text).toContain(EMAIL_PROVIDER[lang]);
  });
});

describe('the Cookie Policy lists every storage key the app writes', () => {
  /** Keys the policy describes by name of the row rather than by key. */
  const DESCRIBED_BY_ROW: Record<string, PerLanguage> = {
    voxium_access_token: { en: 'Access token', fr: 'Jeton d’accès' },
    voxium_refresh_token: { en: 'Refresh token', fr: 'Jeton de rafraîchissement' },
    voxium_trusted_device: { en: 'Trusted-device token', fr: 'Jeton d’appareil de confiance' },
    voxium_e2e_pk_: { en: 'Vault key', fr: 'Clé du coffre' },
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

  const keyCases = [...keys].sort().flatMap((key) => LEGAL_LANGUAGES.map((lang) => [key, lang] as const));

  it.each(keyCases)('names %s (%s)', (key, lang) => {
    const row = DESCRIBED_BY_ROW[key]?.[lang];
    expect(pages.cookies[lang].text, `a new storage key: list "${key}" on the Cookie Policy (${lang})`).toContain(row ?? key);
  });
});

describe('every translation keeps the shape of the English document', () => {
  const count = (html: string, tag: string) => (html.match(new RegExp(`<${tag}\\b`, 'g')) ?? []).length;
  const mailtos = (html: string) => Array.from(html.matchAll(/href="(mailto:[^"]+)"/g), (m) => m[1]).sort();

  /** The elements a translation keeps one for one: blocks, list items, table cells, emphasis and links. */
  const SHAPE_TAGS = ['section', 'h2', 'p', 'li', 'tr', 'th', 'table', 'strong', 'em', 'a'];

  it.each(pageNames)('%s has as many sections, headings, paragraphs, list items, table rows, emphases and links in every language', (name) => {
    expect(count(pages[name].en.html, 'section'), `${name}: the count is not vacuous`).toBeGreaterThan(0);
    expect(count(pages[name].en.html, 'li') + count(pages[name].en.html, 'tr'), `${name}: the count is not vacuous`).toBeGreaterThan(0);
    for (const tag of SHAPE_TAGS) {
      const english = count(pages[name].en.html, tag);
      for (const lang of LEGAL_LANGUAGES) {
        expect(count(pages[name][lang].html, tag), `${name}: <${tag}> in ${lang} against English — a line added to one language only`).toBe(english);
      }
    }
  });

  it.each(pageNames)('%s gives the same contact addresses in every language', (name) => {
    const english = mailtos(pages[name].en.html);
    expect(english.length).toBeGreaterThan(0);
    for (const lang of LEGAL_LANGUAGES) expect(mailtos(pages[name][lang].html), `${name} (${lang})`).toEqual(english);
  });
});

describe('the French documents follow French typography', () => {
  const NO_BREAK = new Set([String.fromCharCode(0x00a0), String.fromCharCode(0x202f)]);

  /** Every place a line could break where French typography forbids it, with some context. */
  function spacingFaults(html: string): string[] {
    const text = rawText(html);
    const faults: string[] = [];
    const at = (i: number) => JSON.stringify(text.slice(Math.max(0, i - 25), i + 10).replace(/\s+/g, ' '));
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      const before = text[i - 1] ?? '';
      const after = text[i + 1] ?? '';
      // : ; ? ! used as punctuation (followed by a space or the end, unlike "vox:securePins:")
      const punctuation = ':;?!'.includes(char) && (after === '' || /\s/.test(after));
      // « and » are always spaced, with a no-break space; so is punctuation
      if (char === '«' && !NO_BREAK.has(after)) faults.push(`after «: ${at(i)}`);
      else if ((char === '»' || punctuation) && !NO_BREAK.has(before)) faults.push(`before ${char}: ${at(i)}`);
      // and a plain space never precedes one of them, whatever follows
      else if (':;?!»'.includes(char) && before === ' ') faults.push(`plain space before ${char}: ${at(i)}`);
      // English quotation marks
      if ('"“”'.includes(char)) faults.push(`quotation mark ${char}: ${at(i)}`);
      // the straight apostrophe: French text uses the typographic ’
      if (char === "'") faults.push(`straight apostrophe: ${at(i)}`);
    }
    return faults;
  }

  it.each(pageNames)('%s puts a no-break space before : ; ? ! and inside « », quotes with « » and elides with ’', (name) => {
    expect(spacingFaults(pages[name].fr.html)).toEqual([]);
  });

  it('the check finds the faults it is meant to find (it is not vacuous)', () => {
    // a plain space before ":", after "«" and before "»", none before ";", two straight quotes
    expect(spacingFaults('<p>Contact : « Voxium »; "ok"</p>')).toHaveLength(6);
    // a plain space before a colon that is not followed by a space
    expect(spacingFaults('<p>voir :suite</p>')).toHaveLength(1);
    // a straight apostrophe, rendered as React escapes it
    expect(spacingFaults('<p>l&#x27;heure</p>')).toHaveLength(1);
    // no-break spaces, storage keys, addresses, host names and ’ pass
    const nbsp = String.fromCharCode(0x00a0);
    expect(spacingFaults(`<p>Contact${nbsp}: «${nbsp}Voxium${nbsp}» vox:securePins:… dpo@voxium.app com.voxium.app l’heure</p>`)).toEqual([]);
  });
});

describe('the positions the documents take are stated in every language', () => {
  /** Rendered text with no-break spaces and typographic apostrophes as plain characters, lowercased. */
  const plain = (text: string) => text.replace(/’/g, "'").toLowerCase();
  const mailtos = (html: string) => Array.from(html.matchAll(/href="mailto:([^"]+)"/g), (m) => m[1]);

  const REFERENCE_VERSION: { what: string } & PerLanguage = {
    what: 'the English version is the reference',
    en: 'the english version is the reference version and prevails in the event of a discrepancy',
    fr: 'la version anglaise est la version de référence et prévaut en cas de divergence',
  };
  const MINOR_CHANGE: { what: string } & PerLanguage = {
    what: 'a minor change may take effect when posted',
    en: 'a minor change, or one with no adverse effect on you, may take effect when it is posted',
    fr: 'une modification mineure, ou sans effet défavorable pour vous, peut prendre effet dès sa publication',
  };
  const CONTINUED_USE: { what: string } & PerLanguage = {
    what: 'continued use accepts a change, and the remedy is to stop',
    en: 'after a change takes effect is acceptance of it; if you do not agree, stop using the Service',
    fr: 'vaut acceptation de celle-ci ; si vous ne l’acceptez pas, cessez d’utiliser le Service',
  };

  /** Phrases each document must carry, per language: the decisions of 2026-10-25. */
  const POSITIONS: Record<'privacy' | 'terms', Array<{ what: string } & PerLanguage>> = {
    terms: [
      {
        what: 'who publishes the Service (legal notice on request while operator.ts has no name and address)',
        en: `voxium is published and operated from ${LEGAL_OPERATOR.country}`,
        fr: `voxium est édité et exploité depuis la ${LEGAL_OPERATOR.country}`,
      },
      REFERENCE_VERSION,
      { what: 'the warranty disclaimer', en: '"as is" and "as available"', fr: '« en l’état » et « selon sa disponibilité »' },
      {
        what: 'the liability disclaimer (no fee cap: the Service takes no payments)',
        en: 'to the fullest extent permitted by law, voxium disclaims liability for damages arising from your use of the service',
        fr: 'dans toute la mesure permise par la loi, voxium décline toute responsabilité pour les dommages découlant de votre utilisation du service',
      },
      {
        what: 'the consumer carve-out of the liability clause',
        en: 'nothing in these terms affects the rights you have as a consumer under mandatory law',
        fr: 'rien dans les présentes conditions n’affecte les droits dont vous disposez en tant que consommateur en vertu du droit impératif',
      },
      MINOR_CHANGE,
      CONTINUED_USE,
      { what: 'the governing law', en: 'these terms are governed by french law', fr: 'régies par le droit français' },
      {
        what: 'the courts, save mandatory consumer law',
        en: 'subject to the jurisdiction of the french courts, unless the mandatory consumer-protection law',
        fr: 'relève de la compétence des juridictions françaises, sauf si le droit impératif de protection des consommateurs',
      },
    ],
    privacy: [
      {
        what: 'who the controller is (legal notice on request while operator.ts has no name and address)',
        en: `the data controller is the publisher of voxium, operating from ${LEGAL_OPERATOR.country}`,
        fr: `le responsable du traitement est l’éditeur de voxium, qui exerce son activité depuis la ${LEGAL_OPERATOR.country}`,
      },
      REFERENCE_VERSION,
      MINOR_CHANGE,
      CONTINUED_USE,
      {
        what: 'consent is asked again, never inferred from continued use (section 7 lists consent as a basis)',
        en: 'where a change concerns processing based on your consent, we ask for your consent again rather than relying on your continued use.',
        fr: 'lorsqu’une modification porte sur un traitement fondé sur votre consentement, nous vous demandons à nouveau votre consentement au lieu de nous fonder sur la poursuite de votre utilisation.',
      },
      { what: 'the privacy contact', en: 'write to our privacy contact at', fr: 'écrivez à notre contact pour les questions de confidentialité' },
      {
        what: 'the supervisory authority',
        en: 'in france, the cnil (cnil.fr/fr/plaintes)',
        fr: 'en france, la cnil (cnil.fr/fr/plaintes)',
      },
    ],
  };

  const positionCases = (['terms', 'privacy'] as const).flatMap((name) => LEGAL_LANGUAGES.map((lang) => [name, lang] as const));

  it.each(positionCases)('%s (%s) states each decided position', (name, lang) => {
    const text = plain(pages[name][lang].text);
    for (const position of POSITIONS[name]) expect(text, `${name} (${lang}): ${position.what}`).toContain(plain(position[lang]));
  });

  it.each(cases)('%s (%s) gives the addresses of operator.ts', (name, lang) => {
    const addresses = mailtos(pages[name][lang].html);
    expect(addresses).toContain(LEGAL_OPERATOR.contactEmail);
    if (name !== 'terms') expect(addresses).toContain(LEGAL_OPERATOR.privacyEmail);
    for (const address of addresses) expect([LEGAL_OPERATOR.contactEmail, LEGAL_OPERATOR.privacyEmail]).toContain(address);
    // opened like the app's other external links (the desktop shell hands them to the mail client)
    for (const link of pages[name][lang].html.match(/<a [^>]*href="mailto:[^>]*>/g) ?? []) {
      expect(link).toContain('target="_blank"');
      expect(link).toContain('rel="noopener noreferrer"');
    }
  });

  it('operator.ts names no publisher yet, so the documents offer the legal notice on request', () => {
    // Filling these in switches both documents to "operated by {name}, {address}" (legalOperator.test.tsx)
    expect(LEGAL_OPERATOR.publisherName).toBeNull();
    expect(LEGAL_OPERATOR.publisherAddress).toBeNull();
    expect(LEGAL_OPERATOR.country).toBe('France');
  });

  it.each(cases)('%s (%s) claims no Data Protection Officer', (name, lang) => {
    const text = pages[name][lang].text;
    expect(text).not.toMatch(/data protection officer|délégué à la protection des données/i);
    // the acronyms (DPO, French DPD), case-sensitive: the privacy address dpo@… is not a designation
    expect(text).not.toMatch(/\bDP[OD]\b/);
  });

  it.each(LEGAL_LANGUAGES)('the supervisory authority link goes to its complaints page, outside the app (%s)', (lang) => {
    const link = /<a [^>]*href="https:\/\/www\.cnil\.fr\/fr\/plaintes"[^>]*>/.exec(pages.privacy[lang].html)?.[0];
    expect(link).toBeDefined();
    expect(link).toContain('target="_blank"');
    expect(link).toContain('rel="noopener noreferrer"');
  });
});
