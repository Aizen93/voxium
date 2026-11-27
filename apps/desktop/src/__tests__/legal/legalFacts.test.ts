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
  SIGNUP,
  SESSIONS,
  APP_VERSION,
  REPORT_RETENTION_MONTHS,
} from '@voxium/shared';
import { LEGAL_LANGUAGES, type LegalLanguage } from '../../components/legal/legalLanguage';
import { LEGAL_OPERATOR, PRIVACY_POLICY_DATES } from '../../components/legal/operator';
import { formatLegalDate, daysBetween } from '../../components/legal/legalDates';
import { PRIVACY_CONTENT } from '../../components/legal/PrivacyContent';
import { TERMS_CONTENT } from '../../components/legal/TermsContent';
import { COOKIE_POLICY_CONTENT } from '../../components/legal/CookiePolicyContent';
import { SIGN_OUT_RETRY_MAX_AGE_MINUTES } from '../../services/sessionRevocationLimits';
import { CREDENTIAL_CHANGE_MARK_SECONDS } from '../../services/credentialChangeLimits';

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
/** The session service (the one minter of tokens): the defaults when JWT_EXPIRES_IN / JWT_REFRESH_EXPIRES_IN are unset. */
const sessionService = readServer('services/sessionService.ts');
const ACCESS_TOKEN_MINUTES = capture(sessionService, /JWT_EXPIRES_IN \|\| '(\d+)m'/, 'the access-token default lifetime');
const REFRESH_REMEMBERED_DAYS = capture(sessionService, /JWT_REFRESH_EXPIRES_IN \|\| '(\d+)d'/, 'the "Remember me" refresh-token default lifetime');
const REFRESH_SESSION_HOURS = capture(
  sessionService,
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

/** Each document's own revision date: a document changes alone. */
const LAST_UPDATED: Record<PageName, PerLanguage> = {
  privacy: {
    // read from the constant through the formatter; the format itself is pinned in the formatLegalDate tests
    en: `Last updated: ${formatLegalDate(PRIVACY_POLICY_DATES.lastUpdated, 'en')}`,
    fr: `Dernière mise à jour : ${formatLegalDate(PRIVACY_POLICY_DATES.lastUpdated, 'fr')}`,
  },
  terms: {
    en: 'Last updated: October 25, 2026',
    fr: 'Dernière mise à jour : 25 octobre 2026',
  },
  cookies: {
    en: 'Last updated: November 21, 2026',
    fr: 'Dernière mise à jour : 21 novembre 2026',
  },
};

/**
 * The change-notice promise (operator.ts), as the Terms and the Privacy Policy
 * state it: in the app, the only channel the Service has for it (announcements;
 * the account e-mails are the sign-up code, the legacy address verification,
 * password reset and the existing-account notice, none of them a change notice).
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
    {
      source: 'SIGNUP.PENDING_TTL_MINUTES',
      en: `that are not completed expire ${SIGNUP.PENDING_TTL_MINUTES} minutes after they start and are then deleted by a daily clean-up`,
      fr: `non finalisées expirent ${SIGNUP.PENDING_TTL_MINUTES} minutes après leur début et sont ensuite supprimées par un nettoyage quotidien`,
    },
    {
      source: 'SIGNUP.LEDGER_WINDOW_DAYS',
      en: `kept for ${SIGNUP.LEDGER_WINDOW_DAYS} days from the first of them, then deleted by a daily clean-up`,
      fr: `conservés pendant ${SIGNUP.LEDGER_WINDOW_DAYS} jours à compter du premier d’entre eux, puis supprimés par un nettoyage quotidien`,
    },
    {
      // The release that introduced server-side sign-out: a fixed fact, never APP_VERSION
      source: 'the release that ended the session on the server at sign-out (a fixed version, not APP_VERSION)',
      en: 'Since version 2.2.0, signing out of the app also ends the session on our servers when the app can reach them',
      fr: 'Depuis la version 2.2.0, la déconnexion de l’application met aussi fin à la session sur nos serveurs',
    },
    {
      source: 'sessionService refreshIdleLifetime(): the idle window of a session, with and without "Remember me"',
      en: `after ${REFRESH_REMEMBERED_DAYS} days without use (${REFRESH_SESSION_HOURS} hours without “Remember me”)`,
      fr: `après ${REFRESH_REMEMBERED_DAYS} jours sans utilisation (${REFRESH_SESSION_HOURS} heures sans « Se souvenir de moi »)`,
    },
    {
      source: 'SESSIONS.MAX_AGE_DAYS',
      en: `at the latest ${SESSIONS.MAX_AGE_DAYS} days after you signed in`,
      fr: `au plus tard ${SESSIONS.MAX_AGE_DAYS} jours après la connexion`,
    },
    {
      source: 'REPORT_RETENTION_MONTHS (@voxium/shared)',
      en: `${REPORT_RETENTION_MONTHS} months after`,
      fr: `${REPORT_RETENTION_MONTHS} mois après`,
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
      source: 'sessionService accessTokenLifetime() JWT_EXPIRES_IN default',
      en: `${ACCESS_TOKEN_MINUTES} minutes, renewed automatically`,
      fr: `${ACCESS_TOKEN_MINUTES} minutes, renouvelé automatiquement`,
    },
    {
      source: 'sessionService refreshIdleLifetime() JWT_REFRESH_EXPIRES_IN default',
      en: `Up to ${REFRESH_REMEMBERED_DAYS} days with “Remember me”`,
      fr: `Jusqu’à ${REFRESH_REMEMBERED_DAYS} jours avec « Se souvenir de moi »`,
    },
    {
      source: 'sessionService refreshIdleLifetime() without "Remember me"',
      en: `${REFRESH_SESSION_HOURS} hours without`,
      fr: `${REFRESH_SESSION_HOURS} heures sans`,
    },
    {
      source: 'TRUSTED_DEVICE_TTL_DAYS',
      en: `${TRUSTED_DEVICE_TTL_DAYS} days; kept when you sign out`,
      fr: `${TRUSTED_DEVICE_TTL_DAYS} jours ; conservé lorsque vous vous déconnectez`,
    },
    {
      source: 'SIGN_OUT_RETRY_MAX_AGE_MINUTES (services/sessionRevocationLimits.ts)',
      en: `for up to ${SIGN_OUT_RETRY_MAX_AGE_MINUTES} minutes to try again`,
      fr: `pendant ${SIGN_OUT_RETRY_MAX_AGE_MINUTES} minutes au plus pour réessayer`,
    },
    {
      source: 'CREDENTIAL_CHANGE_MARK_SECONDS (services/credentialChangeLimits.ts)',
      en: `after about ${CREDENTIAL_CHANGE_MARK_SECONDS} seconds`,
      fr: `au bout d’environ ${CREDENTIAL_CHANGE_MARK_SECONDS} secondes`,
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
    // verify-first sign-up: the account e-mails are no longer only these two
    'account emails (address verification and password reset)',
    // an account deletion no longer deletes the other participant's side of a conversation outright
    'your direct conversations (including the other participant\'s messages in them)',
    // a report no longer always goes with the account that filed it or that it concerns
    'deleted with the account that opened or filed them, or that a report concerns',
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
    'les e-mails liés au compte (vérification de l’adresse et réinitialisation du mot de passe)',
    'vos conversations privées (y compris les messages que l’autre participant y a envoyés)',
    'supprimés avec le compte qui les a ouverts ou effectués, ou que concerne un signalement',
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
    expect(pages[name][lang].text).toContain(LAST_UPDATED[name][lang]);
  });

  it.each(cases)('%s (%s) numbers its sections 1..n in order', (name, lang) => {
    const numbers = pages[name][lang].headings.map((h) => Number(/^(\d+)\. /.exec(h)?.[1]));
    expect(numbers.length).toBeGreaterThan(0);
    expect(numbers).toEqual(numbers.map((_, i) => i + 1));
  });
});

describe('the Privacy Policy tells what removing a direct conversation does', () => {
  const REMOVED_CONVERSATION: PerLanguage = {
    en: 'A direct conversation you remove leaves your own list, and its history up to that moment is no longer shown to you; the other participant keeps the conversation and its messages. It is deleted from our servers once neither participant can reach any of it',
    fr: 'Une conversation privée que vous retirez quitte votre propre liste, et son historique jusqu’à ce moment ne vous est plus affiché ; l’autre participant conserve la conversation et ses messages. Elle est supprimée de nos serveurs dès qu’aucun des deux participants ne peut plus accéder à quoi que ce soit de son contenu',
  };
  const EVERYTHING_ELSE: PerLanguage = { en: 'Everything else is kept', fr: 'Tout le reste est conservé' };

  it.each(LEGAL_LANGUAGES)('states it, once, in the retention list right before "everything else" (%s)', (lang) => {
    const text = pages.privacy[lang].text;
    const at = text.indexOf(REMOVED_CONVERSATION[lang]);
    expect(at, REMOVED_CONVERSATION[lang]).toBeGreaterThan(-1);
    expect(text.indexOf(REMOVED_CONVERSATION[lang], at + 1)).toBe(-1);
    expect(text.indexOf(EVERYTHING_ELSE[lang])).toBe(at + REMOVED_CONVERSATION[lang].length + 1);
  });
});

describe('the Privacy Policy tells what an account deletion keeps of a direct conversation', () => {
  const TITLE: PerLanguage = {
    en: 'Your direct conversations when you delete your account.',
    fr: 'Vos conversations privées lorsque vous supprimez votre compte.',
  };
  const EVERYTHING_ELSE_ITEM: PerLanguage = {
    en: 'Everything else is kept for as long as your account exists. Deleting your account (Settings → Security) deletes with it your profile, your messages and reactions, their attachments, your devices\' keys and key backups, your connection data, your sign-in sessions, your support conversations and your consent records',
    fr: 'Tout le reste est conservé tant que votre compte existe. La suppression de votre compte (Paramètres → Sécurité) supprime avec lui votre profil, vos messages et vos réactions, leurs pièces jointes, les clés et les sauvegardes de clés de vos appareils, vos données de connexion, vos sessions ouvertes, vos conversations de support et les traces de votre consentement',
  };
  const kept = (lang: LegalLanguage) => formatLegalDate(PRIVACY_POLICY_DATES.conversationsKeptFrom, lang);
  const keySentences = (lang: LegalLanguage): string[] => lang === 'en'
    ? [
        `Until ${kept('en')}, deleting your account deletes each of your direct conversations entirely, the other participant's messages included.`,
        `From ${kept('en')}, it deletes your messages in them, with their attachments and the reactions on them, and the other participant keeps the conversation: it becomes read-only for them, it shows a deleted account in your place, and each of your messages is replaced by an empty placeholder that keeps only the time it was sent; the notices that a call started or ended stay, no longer linked to you.`,
        'A conversation the other participant has already removed with its history, or whose other participant\'s account is already deleted, is deleted entirely',
      ]
    : [
        `Jusqu’au ${kept('fr')}, la suppression de votre compte supprime entièrement chacune de vos conversations privées, y compris les messages de l’autre participant.`,
        `À partir du ${kept('fr')}, elle supprime vos messages dans ces conversations, avec leurs pièces jointes et les réactions qu’ils ont reçues, et l’autre participant conserve la conversation : elle devient en lecture seule pour lui, un compte supprimé y apparaît à votre place, et chacun de vos messages est remplacé par un emplacement vide qui ne conserve que l’heure de son envoi ; les mentions de début et de fin d’appel restent, sans lien avec vous.`,
        'Une conversation que l’autre participant a déjà retirée avec son historique, ou dont l’autre participant a déjà supprimé son compte, est supprimée entièrement',
      ];

  it.each(LEGAL_LANGUAGES)('holds the reworded "everything else" item, then the new item right after it (%s)', (lang) => {
    const text = pages.privacy[lang].text;
    const at = text.indexOf(EVERYTHING_ELSE_ITEM[lang]);
    expect(at, EVERYTHING_ELSE_ITEM[lang]).toBeGreaterThan(-1);
    expect(text.indexOf(TITLE[lang])).toBe(at + EVERYTHING_ELSE_ITEM[lang].length + 1);
  });

  it.each(LEGAL_LANGUAGES)('holds the new item\'s title and its key sentences (%s)', (lang) => {
    const text = pages.privacy[lang].text;
    expect(text).toContain(TITLE[lang]);
    for (const sentence of keySentences(lang)) expect(text, sentence).toContain(sentence);
  });

  it.each(LEGAL_LANGUAGES)('prints the date from which the conversation is kept, formatted, twice for each rule that prints it (%s)', (lang) => {
    const text = pages.privacy[lang].text;
    // The reports item prints its own date twice; when both rules start on the
    // same day the formatted text is the same, so it is counted once for each
    const printed = PRIVACY_POLICY_DATES.reportsKeptFrom === PRIVACY_POLICY_DATES.conversationsKeptFrom ? 4 : 2;
    expect(text.split(kept(lang))).toHaveLength(printed + 1);
    expect(text).not.toContain(PRIVACY_POLICY_DATES.conversationsKeptFrom);
  });

  it('allows at least the notice period between the last update and the day the rule starts', () => {
    expect(
      daysBetween(PRIVACY_POLICY_DATES.lastUpdated, PRIVACY_POLICY_DATES.conversationsKeptFrom),
      'conversationsKeptFrom must be at least LEGAL_OPERATOR.changeNoticeDays after lastUpdated',
    ).toBeGreaterThanOrEqual(LEGAL_OPERATOR.changeNoticeDays);
  });

  it('has had its two dates looked at again for the current version', () => {
    expect(
      PRIVACY_POLICY_DATES.confirmedForVersion,
      `The app is at ${APP_VERSION}, the Privacy Policy dates were confirmed for ${PRIVACY_POLICY_DATES.confirmedForVersion}. ` +
        'In operator.ts (PRIVACY_POLICY_DATES): set lastUpdated to the release day, conversationsKeptFrom and reportsKeptFrom to that day plus at least ' +
        'LEGAL_OPERATOR.changeNoticeDays, then set confirmedForVersion to the released version.',
    ).toBe(APP_VERSION);
  });
});

describe('the Privacy Policy tells what an account deletion keeps of a report', () => {
  const MONTHS = REPORT_RETENTION_MONTHS;
  const SUPPORT_ITEM: PerLanguage = {
    en: 'Support conversations have no automatic expiry: they are kept for support, and are deleted with the account that opened them',
    fr: 'Les conversations de support n’expirent pas automatiquement : elles sont conservées pour le support, et sont supprimées avec le compte qui les a ouvertes',
  };
  const kept = (lang: LegalLanguage) => formatLegalDate(PRIVACY_POLICY_DATES.reportsKeptFrom, lang);
  const sentences = (lang: LegalLanguage): string[] => lang === 'en'
    ? [
        'Reports. A report is kept for moderation and, while the accounts it concerns exist, has no automatic expiry.',
        `Until ${kept('en')}, deleting your account deletes the reports you filed and the reports that concern you.`,
        `From ${kept('en')}, it keeps them, so that a report does not disappear when the person it concerns deletes their account.`,
        'A kept report is no longer linked to the deleted account.',
        "The report keeps the username of the reported account (for a report about a space, that of its owner), the reason given, the copy of the reported message (or of the reported space's name and description), the identifier of the channel, conversation or space it concerns, and the decision taken on it, if any.",
        `It is deleted ${MONTHS} months after the deletion of that account, or, when the account that filed it and the reported account are both deleted, ${MONTHS} months after the earlier of the two deletions.`,
        `A report you filed about someone else is therefore deleted ${MONTHS} months after you delete your account, even if the other account still exists`,
        'reports, in the cases described under “Reports” above;',
      ]
    : [
        'Les signalements. Un signalement est conservé pour la modération et, tant que les comptes qu’il concerne existent, n’expire pas automatiquement.',
        `Jusqu’au ${kept('fr')}, la suppression de votre compte supprime les signalements que vous avez effectués et ceux qui vous concernent.`,
        `À partir du ${kept('fr')}, elle les conserve, afin qu’un signalement ne disparaisse pas lorsque la personne qu’il concerne supprime son compte.`,
        'Un signalement conservé n’est plus lié au compte supprimé.',
        'Le signalement conserve le nom d’utilisateur du compte signalé (pour un signalement visant un espace, celui de son propriétaire), le motif indiqué, la copie du message signalé (ou du nom et de la description de l’espace signalé), l’identifiant du salon, de la conversation ou de l’espace qu’il concerne, et la décision prise à son sujet, le cas échéant.',
        `Il est supprimé ${MONTHS} mois après la suppression de ce compte, ou, lorsque le compte qui l’a effectué et le compte signalé sont tous deux supprimés, ${MONTHS} mois après la plus ancienne des deux suppressions.`,
        `Un signalement que vous avez effectué au sujet d’une autre personne est donc supprimé ${MONTHS} mois après la suppression de votre compte, même si l’autre compte existe encore`,
        'les signalements, dans les cas décrits sous « Les signalements » ci-dessus ;',
      ];

  it.each(LEGAL_LANGUAGES)('holds the support item, then the reports item right after it (%s)', (lang) => {
    const text = pages.privacy[lang].text;
    const at = text.indexOf(SUPPORT_ITEM[lang]);
    expect(at, SUPPORT_ITEM[lang]).toBeGreaterThan(-1);
    expect(text.indexOf(sentences(lang)[0])).toBe(at + SUPPORT_ITEM[lang].length + 1);
  });

  it.each(LEGAL_LANGUAGES)('holds every sentence of the reports item and its mention after a deletion (%s)', (lang) => {
    const text = pages.privacy[lang].text;
    for (const sentence of sentences(lang)) expect(text, sentence).toContain(sentence);
  });

  it.each(LEGAL_LANGUAGES)('prints the number of months only through the constant, the date never as written (%s)', (lang) => {
    const text = pages.privacy[lang].text;
    expect(text).not.toContain(PRIVACY_POLICY_DATES.reportsKeptFrom);
    const word = lang === 'en' ? 'months after' : 'mois après';
    expect(text.split(`${MONTHS} ${word}`)).toHaveLength(4);
  });

  it('allows at least the notice period between the last update and the day the report rule starts', () => {
    expect(
      daysBetween(PRIVACY_POLICY_DATES.lastUpdated, PRIVACY_POLICY_DATES.reportsKeptFrom),
      'reportsKeptFrom must be at least LEGAL_OPERATOR.changeNoticeDays after lastUpdated',
    ).toBeGreaterThanOrEqual(LEGAL_OPERATOR.changeNoticeDays);
  });
});

describe('the legal documents tell what a sign-in session is, how long it lasts and how it ends', () => {
  const CONNECTION_DATA_END: PerLanguage = {
    en: 'How long it is kept is set out under “Retention” below',
    fr: 'Leur durée de conservation est précisée sous « Conservation » ci-dessous',
  };
  const SESSIONS_COLLECTED: PerLanguage = {
    en: 'Sign-in sessions, one record for each device or browser your account is signed in on: when you signed in, when the session last renewed itself, whether you chose “Remember me”, and the kind of app and operating system (for example “Desktop app, Windows”). It lets us end a session on our servers and show you where you are signed in. It holds no IP address, no device name and no browser fingerprint.',
    fr: 'Sessions ouvertes, un enregistrement pour chaque appareil ou navigateur sur lequel votre compte est connecté : la date de la connexion, la date du dernier renouvellement de la session, si vous avez choisi « Se souvenir de moi », et le type d’application et de système d’exploitation (par exemple « Application de bureau, Windows »). Il nous permet de mettre fin à une session sur nos serveurs et de vous montrer où vous êtes connecté. Il ne contient ni adresse IP, ni nom d’appareil, ni empreinte de navigateur.',
  };
  const BACKUP_CODES_HASHED: PerLanguage = {
    en: 'whose backup codes are stored hashed.',
    fr: 'les codes de secours stockés hachés.',
  };
  const SESSIONS_STORAGE: PerLanguage = {
    en: `Since version 2.2.0, signing out of the app also ends the session on our servers when the app can reach them; otherwise the session ends by itself after ${REFRESH_REMEMBERED_DAYS} days without use (${REFRESH_SESSION_HOURS} hours without “Remember me”). Settings → Security, on any of your devices, shows where you are signed in and lets you sign out of the others.`,
    fr: `Depuis la version 2.2.0, la déconnexion de l’application met aussi fin à la session sur nos serveurs lorsque l’application peut les joindre ; à défaut, la session prend fin d’elle-même après ${REFRESH_REMEMBERED_DAYS} jours sans utilisation (${REFRESH_SESSION_HOURS} heures sans « Se souvenir de moi »). Paramètres → Sécurité, sur chacun de vos appareils, indique où vous êtes connecté et vous permet de vous déconnecter des autres.`,
  };
  const CONNECTION_RETENTION_END: PerLanguage = {
    en: 'are rotated automatically and kept only for a short period',
    fr: 'font l’objet d’une rotation automatique et ne sont conservés que pendant une courte période',
  };
  const SESSIONS_RETENTION: PerLanguage = {
    en: `Sign-in sessions end when the app signs out of them on our servers, when you sign out of them from another device, when your password is changed or reset, after ${REFRESH_REMEMBERED_DAYS} days without use (${REFRESH_SESSION_HOURS} hours without “Remember me”), and at the latest ${SESSIONS.MAX_AGE_DAYS} days after you signed in; the record is then deleted within a day`,
    fr: `Les sessions ouvertes prennent fin lorsque l’application s’en déconnecte auprès de nos serveurs, lorsque vous y mettez fin depuis un autre appareil, lorsque votre mot de passe est changé ou réinitialisé, après ${REFRESH_REMEMBERED_DAYS} jours sans utilisation (${REFRESH_SESSION_HOURS} heures sans « Se souvenir de moi »), et au plus tard ${SESSIONS.MAX_AGE_DAYS} jours après la connexion ; l’enregistrement est alors supprimé dans la journée`,
  };
  const CONTRACT_BASIS: PerLanguage = {
    en: 'your account and its sign-in sessions, profile, messages, presence and calls: the Service you asked for',
    fr: 'votre compte et ses sessions ouvertes, votre profil, vos messages, votre présence et vos appels : le Service que vous avez demandé',
  };

  it.each(LEGAL_LANGUAGES)('the Privacy Policy lists the session record right after the connection data item (%s)', (lang) => {
    const text = pages.privacy[lang].text;
    expect(text, SESSIONS_COLLECTED[lang]).toContain(`${CONNECTION_DATA_END[lang]} ${SESSIONS_COLLECTED[lang]}`);
    expect(text.split(SESSIONS_COLLECTED[lang])).toHaveLength(2);
  });

  it.each(LEGAL_LANGUAGES)('the Privacy Policy says in Storage & Security that a sign-out ends the session on our servers, and what happens otherwise (%s)', (lang) => {
    const text = pages.privacy[lang].text;
    expect(text, SESSIONS_STORAGE[lang]).toContain(`${BACKUP_CODES_HASHED[lang]} ${SESSIONS_STORAGE[lang]}`);
  });

  it.each(LEGAL_LANGUAGES)('the Privacy Policy retention list gives the session item right after the connection data one (%s)', (lang) => {
    const text = pages.privacy[lang].text;
    expect(text, SESSIONS_RETENTION[lang]).toContain(`${CONNECTION_RETENTION_END[lang]} ${SESSIONS_RETENTION[lang]}`);
  });

  it.each(LEGAL_LANGUAGES)('the Privacy Policy keeps the sessions with the account, and bases them on the contract (%s)', (lang) => {
    const text = pages.privacy[lang].text;
    expect(text).toContain(CONTRACT_BASIS[lang]);
  });

  // The Cookie Policy: the three rows or sentences the session change reworded
  const COOKIE_SENTENCES: PerLanguage[] = [
    {
      en: `Signing out also ends it on our servers when they can be reached; when they cannot, the app keeps it in memory, never on disk, for up to ${SIGN_OUT_RETRY_MAX_AGE_MINUTES} minutes to try again`,
      fr: `La déconnexion met aussi fin à la session sur nos serveurs lorsqu’ils sont joignables ; dans le cas contraire, l’application le garde en mémoire, jamais sur le disque, pendant ${SIGN_OUT_RETRY_MAX_AGE_MINUTES} minutes au plus pour réessayer`,
    },
    {
      en: 'changing your password invalidates it, and signing out of your other sessions invalidates it on your other devices',
      fr: 'changer votre mot de passe l’invalide, et vous déconnecter de vos autres sessions l’invalide sur vos autres appareils',
    },
    {
      en: 'Signing out removes your session from the credential store and, when our servers can be reached, ends it there too.',
      fr: 'La déconnexion supprime votre session du gestionnaire d’identifiants et, lorsque nos serveurs sont joignables, met aussi fin à la session sur ceux-ci.',
    },
    // voxium_credential_change: what it holds, and when it goes
    {
      en: 'It holds the time until which that answer can arrive and a short code computed from your account’s identifier, from which the identifier cannot be read back; the tabs of another account ignore it',
      fr: 'Elle contient l’heure jusqu’à laquelle cette réponse peut arriver et un code court calculé à partir de l’identifiant de votre compte, qui ne permet pas de retrouver cet identifiant ; les onglets d’un autre compte l’ignorent',
    },
    {
      en: `Written when the change starts; removed once its answer has been stored or the change has failed, when you sign out in that tab, or, if that tab was closed meanwhile, by the next session renewal in this browser after about ${CREDENTIAL_CHANGE_MARK_SECONDS} seconds`,
      fr: `Écrite au début du changement ; supprimée une fois sa réponse enregistrée ou l’échec du changement constaté, lorsque vous vous déconnectez dans cet onglet, ou, si cet onglet a été fermé entre-temps, par le renouvellement de session suivant dans ce navigateur au bout d’environ ${CREDENTIAL_CHANGE_MARK_SECONDS} secondes`,
    },
  ];

  it.each(LEGAL_LANGUAGES)('the Cookie Policy states the retry window, the other-sessions effect on the trusted-device token and the server-side end (%s)', (lang) => {
    const text = pages.cookies[lang].text;
    for (const sentence of COOKIE_SENTENCES) expect(text, sentence[lang]).toContain(sentence[lang]);
  });

  it('keeps the session lifetimes the documents state in step with the code that applies them', () => {
    for (const value of [SESSIONS.MAX_AGE_DAYS, SIGN_OUT_RETRY_MAX_AGE_MINUTES, CREDENTIAL_CHANGE_MARK_SECONDS]) {
      expect(Number.isInteger(value) && value > 0, String(value)).toBe(true);
    }
    // the idle window and the cap are applied from these constants (never a second copy of a figure)
    expect(sessionService).toContain('SESSIONS.MAX_AGE_DAYS');
  });
});

describe('formatLegalDate', () => {
  const EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const FR = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

  it('writes the dates the policy prints (the format itself is pinned here)', () => {
    expect(formatLegalDate('2026-12-04', 'en')).toBe('December 4, 2026');
    expect(formatLegalDate('2026-12-04', 'fr')).toBe('4 décembre 2026');
    expect(formatLegalDate('2026-11-20', 'en')).toBe('November 20, 2026');
    expect(formatLegalDate('2026-11-20', 'fr')).toBe('20 novembre 2026');
  });

  it.each(EN.map((name, i) => [i + 1, name, FR[i]] as const))('names month %i in both languages', (month, en, fr) => {
    const iso = `2026-${String(month).padStart(2, '0')}-15`;
    expect(formatLegalDate(iso, 'en')).toBe(`${en} 15, 2026`);
    expect(formatLegalDate(iso, 'fr')).toBe(`15 ${fr} 2026`);
  });

  it('writes 1er for the first of a month in French only, and no leading zero on the day', () => {
    expect(formatLegalDate('2026-12-01', 'fr')).toBe('1er décembre 2026');
    expect(formatLegalDate('2026-12-01', 'en')).toBe('December 1, 2026');
    expect(formatLegalDate('2026-03-09', 'fr')).toBe('9 mars 2026');
    expect(formatLegalDate('2026-03-09', 'en')).toBe('March 9, 2026');
  });

  it('accepts a leap day only in a leap year', () => {
    expect(formatLegalDate('2028-02-29', 'en')).toBe('February 29, 2028');
    expect(() => formatLegalDate('2027-02-29', 'en')).toThrow();
    expect(() => formatLegalDate('2100-02-29', 'en')).toThrow();
  });

  it.each(['2026-02-30', '2026-13-01', '2026-00-10', '2026-04-31', '2026-12-00', '20261204', '2026-1-4', ''])(
    'refuses "%s"',
    (iso) => {
      expect(() => formatLegalDate(iso, 'en')).toThrow();
      expect(() => formatLegalDate(iso, 'fr')).toThrow();
    },
  );

  it('counts whole days between two dates', () => {
    expect(daysBetween('2026-11-20', '2026-12-04')).toBe(14);
    expect(daysBetween('2026-12-04', '2026-11-20')).toBe(-14);
    expect(daysBetween('2026-12-31', '2027-01-01')).toBe(1);
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
    let rest = page.text.replace(LAST_UPDATED[name][lang], ' ');
    for (const heading of page.headings) {
      rest = rest.replace(heading, heading.replace(/^\d+\. /, ''));
    }
    for (const pin of PINS[name]) rest = rest.split(pin[lang]).join(' ');
    // the Privacy Policy's second date, pinned to its constant (PRIVACY_POLICY_DATES)
    if (name === 'privacy') rest = rest.split(formatLegalDate(PRIVACY_POLICY_DATES.conversationsKeptFrom, lang)).join(' ');
    if (name === 'privacy') rest = rest.split(formatLegalDate(PRIVACY_POLICY_DATES.reportsKeptFrom, lang)).join(' ');
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

describe('the sign-up the Privacy Policy describes is the one the server runs', () => {
  const signupService = readServer('services/signupService.ts');

  it('reads the lifetimes the pins state from SIGNUP, and keys the mail ledger on a mailbox digest', () => {
    // the pending row's life, and its purge by the daily hygiene sweep
    expect(signupService).toContain('expiresAt: new Date(now + SIGNUP.PENDING_TTL_MINUTES * MINUTE)');
    expect(signupService).toContain('prisma.pendingRegistration.deleteMany({ where: { expiresAt: { lt: new Date() } } })');
    expect(signupService).toContain('SIGNUP.LEDGER_WINDOW_DAYS * 24 * 60 * MINUTE');
    expect(registrationHygiene).toContain('await purgeExpiredSignupState()');
    // the ledger holds a digest, never the address
    expect(signupService).toContain('const mailbox = mailboxDigest(email);');
    expect(signupService).toContain('claimSignupMailSlot(mailbox)');
    // an existing verified account is sent the notice, never a code
    expect(signupService).toContain('sendSignupExistingAccountEmail(email)');
    for (const value of [SIGNUP.PENDING_TTL_MINUTES, SIGNUP.LEDGER_WINDOW_DAYS]) {
      expect(Number.isInteger(value) && value > 0, String(value)).toBe(true);
    }
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
      {
        what: 'verify-first sign-up: no account before the mailed code (signupService.completeRegistration)',
        en: 'no account is created until you enter the code we email to that address',
        fr: 'aucun compte n’est créé tant que vous n’avez pas saisi le code que nous envoyons par e-mail à cette adresse',
      },
      {
        what: 'what a sign-up attempt holds (the pending_registrations columns)',
        en: 'the username, email address, display name and password (hashed) you enter, the time you accepted the terms of service and this privacy policy, and the ip address the sign-up came from',
        fr: 'le nom d’utilisateur, l’adresse e-mail, le nom d’affichage et le mot de passe (haché) que vous saisissez, la date et l’heure auxquelles vous avez accepté les conditions d’utilisation et la présente politique de confidentialité, et l’adresse ip d’où provient l’inscription',
      },
      {
        what: 'the sign-up mail ledger keys a digest of the mailbox, never the address (signup_mail_ledger.mailbox_hash)',
        en: 'a hashed form of the mailbox (never the address itself) and the number of sign-up emails sent to it',
        fr: 'une forme hachée de la boîte de réception (jamais l’adresse elle-même) et le nombre d’e-mails d’inscription qui lui ont été envoyés',
      },
      {
        what: 'the existing-account notice (sendSignupExistingAccountEmail)',
        en: 'a notice to the holder of an address that already has an account when someone tries to sign up with it',
        fr: 'lorsque quelqu’un tente de s’inscrire avec une adresse qui a déjà un compte, un avis adressé au titulaire de cette adresse',
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
