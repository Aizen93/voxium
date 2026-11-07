import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { PERMISSION_LIST, LIMITS, DISCOVERY_TIER_TOP_FRACTION, TRUSTED_DEVICE_TTL_DAYS } from '@voxium/shared';
import { SUPPORTED_LANGUAGES } from '../../i18n';
import { THEMES } from '../../stores/settingsStore';

/**
 * The facts the copy states, pinned to the code that makes them true.
 *
 * Why this exists: the landing page said "20 Permission Flags" for months
 * after CREATE_SECURE_CHANNELS and MANAGE_WEBHOOKS made it 22, promised "25+
 * users per channel" while the default voice cap is 12, and the Security tab
 * said two-factor asks for a code at every sign-in although a verified device
 * is trusted for 30 days. A number written into eleven translations drifts the
 * moment the code changes, and nothing else notices. So every count or limit
 * the copy states is read back here, in every locale, from the constant it
 * describes.
 *
 * Numbers are compared as digits (Arabic-Indic and fullwidth digits folded to
 * ASCII), after removing {{placeholders}} and <1> tags, so word order and
 * phrasing stay free per language.
 */

const SRC = join(__dirname, '..', '..');
const LOCALES_DIR = join(SRC, 'i18n', 'locales');
const LANDING_PAGE = join(SRC, 'pages', 'LandingPage.tsx');

type Tree = { [k: string]: Tree | string };
const localeFiles = readdirSync(LOCALES_DIR).filter((f) => f.endsWith('.json'));
const locales = localeFiles.map((file) => ({
  name: file.replace(/\.json$/, ''),
  bundle: JSON.parse(readFileSync(join(LOCALES_DIR, file), 'utf-8')) as Tree,
}));

function lookup(tree: Tree, key: string): string {
  const value = key.split('.').reduce<Tree | string | undefined>(
    (node, part) => (node && typeof node === 'object' ? node[part] : undefined),
    tree,
  );
  if (typeof value !== 'string') throw new Error(`missing key ${key}`);
  return value;
}

function leaves(tree: Tree, prefix = ''): [string, string][] {
  return Object.entries(tree).flatMap(([k, v]) =>
    typeof v === 'string' ? [[prefix + k, v] as [string, string]] : leaves(v, `${prefix}${k}.`));
}

/** The numbers a sentence states, as integers, in order of appearance. */
function numbersIn(text: string): number[] {
  const folded = text
    .replace(/\{\{[^}]*\}\}/g, ' ')
    .replace(/<\/?\d+>/g, ' ')
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06F0))
    .replace(/[\uFF10-\uFF19]/g, (d) => String(d.charCodeAt(0) - 0xFF10));
  return (folded.match(/\d+/g) ?? []).map(Number);
}

describe('locale copy states the facts the code implements', () => {
  it('ships one locale file per supported language', () => {
    expect(locales.map((l) => l.name).sort()).toEqual(SUPPORTED_LANGUAGES.map((l) => l.code).sort());
    expect(locales.find((l) => l.name === 'en'), 'en.json is the reference locale').toBeDefined();
  });

  it.each(locales.map((l) => [l.name, l.bundle] as const))('%s: the landing showcase counts match the code', (_name, bundle) => {
    expect(numbersIn(lookup(bundle, 'landing.showcase.permissionLabel')), 'permission flags = PERMISSION_LIST.length').toEqual([PERMISSION_LIST.length]);
    expect(numbersIn(lookup(bundle, 'landing.showcase.themeLabel')), 'built-in themes = THEMES.length').toEqual([THEMES.length]);
    expect(numbersIn(lookup(bundle, 'landing.showcase.languageLabel')), 'languages = SUPPORTED_LANGUAGES.length').toEqual([SUPPORTED_LANGUAGES.length]);
  });

  it('the "RTL support" the language label claims exists', () => {
    expect(SUPPORTED_LANGUAGES.some((l) => 'dir' in l && l.dir === 'rtl')).toBe(true);
  });

  it.each(locales.map((l) => [l.name, l.bundle] as const))('%s: voice copy states the default per-channel cap, not a capacity nobody gets by default', (_name, bundle) => {
    expect(numbersIn(lookup(bundle, 'landing.features.voiceDesc'))).toEqual([LIMITS.MAX_VOICE_USERS_PER_CHANNEL]);
    expect(numbersIn(lookup(bundle, 'landing.comparison.sfuVoice'))).toEqual([]);
  });

  it.each(locales.map((l) => [l.name, l.bundle] as const))('%s: account-security copy matches the auth limits', (_name, bundle) => {
    expect(numbersIn(lookup(bundle, 'auth.register.passwordPlaceholder'))).toEqual([LIMITS.PASSWORD_MIN]);
    expect(numbersIn(lookup(bundle, 'auth.totp.subtitle'))).toContain(LIMITS.TOTP_CODE_LENGTH);
    expect(numbersIn(lookup(bundle, 'settings.security.scanQRCode'))).toContain(LIMITS.TOTP_CODE_LENGTH);
    // A verified sign-in trusts the device (authService signs the token with
    // TRUSTED_DEVICE_TTL_DAYS): "a code at every sign-in" was wrong
    expect(numbersIn(lookup(bundle, 'settings.security.twoFactorEnabled'))).toContain(TRUSTED_DEVICE_TTL_DAYS);
  });

  it.each(locales.map((l) => [l.name, l.bundle] as const))('%s: the badge hint quotes the Diamond cut', (_name, bundle) => {
    expect(numbersIn(lookup(bundle, 'discovery.tier.none'))).toEqual([Math.round(DISCOVERY_TIER_TOP_FRACTION.diamond * 100)]);
  });

  it.each(locales.map((l) => [l.name, l.bundle] as const))('%s: copy names features by the terms the app uses for them', (_name, bundle) => {
    // Only invite-only secure channels are end-to-end encrypted, never a
    // channel that is merely hidden by permissions
    expect(lookup(bundle, 'landing.features.privacyDesc').toLowerCase()).toContain(lookup(bundle, 'secureChannel.sectionTitle').toLowerCase());
    // Creating invites takes a permission @everyone does not have by default
    expect(lookup(bundle, 'serverSettings.general.invitesOpen')).toContain(lookup(bundle, 'permissions.CREATE_INVITES.name'));
    // Notifications are native on Windows, macOS and Linux alike
    expect(lookup(bundle, 'settings.audio.desktopNotificationsDesc')).not.toMatch(/windows/i);
  });

  // The word each locale uses for "webhook" (the same stems webhookKeys.test.ts holds the Integrations tab to)
  const WEBHOOK_STEMS: Record<string, string> = {
    en: 'webhook', fr: 'webhook', de: 'webhook', es: 'webhook', pt: 'webhook',
    ru: 'вебхук', uk: 'вебхук', ja: 'ウェブフック', ko: '웹후크', zh: 'webhook', ar: 'خطاف',
  };

  it.each(locales.map((l) => [l.name, l.bundle] as const))('%s: the comparison table shows the incoming webhooks that shipped', (name, bundle) => {
    expect(WEBHOOK_STEMS[name], `${name}.json has no webhook stem in this test`).toBeDefined();
    expect(lookup(bundle, 'landing.comparison.webhooksBotsPlanned').toLowerCase()).toContain(WEBHOOK_STEMS[name]);
  });

  it('the "Custom Bots / API" row uses that cell, not a bare "Planned"', () => {
    const source = readFileSync(LANDING_PAGE, 'utf-8');
    expect(source).toMatch(/feature: t\('landing\.comparison\.customBots'\),\s*voxium: t\('landing\.comparison\.webhooksBotsPlanned'\)/);
  });

  // Voxium is source-available (VCL-1.0): no locale may call it open source,
  // in any of the ways a translation says it (a word may sit in between)
  const OPEN_SOURCE = /open[- ]?source|quelloffen|logiciel libre|code source ouvert|código abierto|código aberto|открыт\S*(?:\s+\S+)?\s+исходн|відкрит\S*(?:\s+\S+)?\s+код|オープンソース|오픈\s*소스|开源|مفتوحة?\s+المصدر/iu;

  it('the open-source guard catches the phrasings it is meant to', () => {
    for (const phrase of ['Open source platform', 'з відкритим вихідним кодом', 'с открытым исходным кодом', 'منصة مفتوحة المصدر', 'برنامج مفتوح المصدر', 'un logiciel libre', '오픈 소스', '开源平台']) {
      expect(phrase, phrase).toMatch(OPEN_SOURCE);
    }
    // ...and not the source-available wording the locales actually use
    for (const phrase of ['Відкритий для аудиту вихідний код', 'Открытый для аудита исходный код', 'Code source public']) {
      expect(phrase, phrase).not.toMatch(OPEN_SOURCE);
    }
  });

  it.each(locales.map((l) => [l.name, l.bundle] as const))('%s: never calls Voxium open source (it is source-available, VCL-1.0)', (_name, bundle) => {
    // The discovery tag names the topic a community is about, not Voxium's licence
    const claims = leaves(bundle).filter(([key, text]) => !key.startsWith('discovery.tags.') && OPEN_SOURCE.test(text));
    expect(claims.map(([key]) => key)).toEqual([]);
  });

  it('ar.json writes every number with the Western digits its interpolated counts use', () => {
    const ar = locales.find((l) => l.name === 'ar')!;
    const mixed = leaves(ar.bundle).filter(([, text]) => /[\u0660-\u0669\u06F0-\u06F9]/.test(text)).map(([key]) => key);
    expect(mixed).toEqual([]);
  });
});
