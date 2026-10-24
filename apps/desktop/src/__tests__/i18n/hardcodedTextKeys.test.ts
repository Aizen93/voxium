// @vitest-environment node
// Pure filesystem check — no DOM, and jsdom does not give this module a
// file:// import.meta.url to resolve the locale directory against.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILT_IN_THEME_IDS, THEME_COLOR_KEYS, THEME_COLOR_GROUPS, THEME_PATTERN_TYPES, THEME_PATTERN_AREAS } from '@voxium/shared';

/**
 * "No hardcoded messages": every sentence the desktop app shows comes from the
 * 11 locale files. This suite pins the surfaces that used to carry English
 * literals (toasts in the stores, notifications, window controls, the updater,
 * the theme editor and marketplace, the landing demos, the app miniature) and
 * every key they were given, so a missing translation or a literal creeping
 * back fails here instead of reaching a non-English user.
 */

const SRC = fileURLToPath(new URL('../../', import.meta.url));
const LOCALE_DIR = fileURLToPath(new URL('../../i18n/locales/', import.meta.url));

const SOURCES = [
  'components/chat/ImageLightbox.tsx',
  'components/chat/MentionAutocomplete.tsx',
  'components/chat/MessageContent.tsx',
  'components/chat/MessageInput.tsx',
  'components/chat/MessageItem.tsx',
  'components/chat/MessageList.tsx',
  'components/chat/ReactionDisplay.tsx',
  'components/common/AppShellMock.tsx',
  'components/common/EmojiPicker.tsx',
  'components/common/ImageUploadButton.tsx',
  'components/common/UserProfilePopup.tsx',
  'components/dm/DMCallPanel.tsx',
  'components/dm/DMMessageList.tsx',
  'components/dm/SupportTicketView.tsx',
  'components/layout/AnnouncementBanner.tsx',
  'components/layout/MainLayout.tsx',
  'components/layout/TitleBar.tsx',
  'components/layout/ToastContainer.tsx',
  'components/layout/UserCard.tsx',
  'components/search/SearchModal.tsx',
  'components/server/CreateServerModal.tsx',
  'components/server/RoleEditor.tsx',
  'components/server/SpacesStrip.tsx',
  'components/settings/SettingsModal.tsx',
  'components/settings/ThemeBrowser.tsx',
  'components/settings/ThemeEditor.tsx',
  'components/settings/ThemePreviewBar.tsx',
  'components/updater/UpdateChecker.tsx',
  'components/voice/AnnotationToolbar.tsx',
  'components/voice/ConnectionQuality.tsx',
  'components/voice/DMVoicePanel.tsx',
  'pages/LandingPage.tsx',
  'pages/PrivacyPage.tsx',
  'pages/TermsPage.tsx',
  'services/themeEngine.ts',
  'stores/chatStore.ts',
  'stores/dmStore.ts',
  'stores/friendStore.ts',
  'stores/serverStore.ts',
  'stores/settingsStore.ts',
  'stores/supportStore.ts',
  'stores/voiceStore.ts',
  'utils/notificationAuthor.ts',
];

/** Every key this change introduced (serverErrors.* is pinned by serverErrorsCoverage.test.ts). */
const NEW_KEYS = [
  'common.dismiss', 'common.download', 'common.preview', 'common.icon', 'common.minimize', 'common.maximize', 'common.restore',
  'common.ctrlKey',
  'settings.security.qrCodeAlt',
  'settings.appearance.publishTitle', 'settings.appearance.unpublishTitle',
  'settings.audio.microphoneFallback', 'settings.audio.speakerFallback', 'settings.audio.keys.backquote', 'settings.audio.keys.space',
  'settings.audio.keys.tab', 'settings.audio.keys.capsLock', 'settings.audio.keys.shiftLeft', 'settings.audio.keys.shiftRight',
  'settings.audio.keys.controlLeft', 'settings.audio.keys.controlRight', 'settings.audio.keys.altLeft', 'settings.audio.keys.altRight',
  'settings.audio.keys.metaLeft', 'settings.audio.keys.metaRight', 'settings.audio.keys.numpad',
  'chat.failedToLoadMessages', 'chat.welcomeTitle', 'chat.welcomeSubtitle', 'chat.searchEmoji',
  'chat.mentionEveryone.label', 'chat.mentionEveryone.description', 'chat.mentionEveryone.notificationTitle',
  'chat.mentionAutocomplete.header', 'chat.mentionAutocomplete.searching',
  'dm.failedToLoadConversations',
  'friends.failedToLoad', 'friends.requestReceived', 'friends.requestAccepted',
  'server.failedToLoadServers', 'server.failedToLoadServer', 'server.failedToLoadMembers', 'server.deletedToast',
  'voice.measuring',
  'voice.toasts.movedToAnotherChannel', 'voice.toasts.micDenied', 'voice.toasts.joinFailed', 'voice.toasts.connectionTimedOut',
  'voice.toasts.connectionFailed', 'voice.toasts.connectionLost', 'voice.toasts.connectionFailedManual', 'voice.toasts.establishFailed',
  'voice.toasts.mutedByModerator', 'voice.toasts.deafenedByModerator', 'voice.toasts.screenShareFailed', 'voice.toasts.micIssue',
  'attachment.downloadedName', 'attachment.image',
  'support.ticketClosed',
  'landing.nav.menu',
  'landing.footer.backToHome',
  'landing.funding.youValue', 'landing.funding.zeroValue',
  'landing.demo.themeAria', 'landing.demo.you', 'landing.demo.chatTryTheme', 'landing.demo.chatLookingClean', 'landing.demo.chatLoveIt',
  'landing.demo.roleAdmin', 'landing.demo.roleModerator', 'landing.demo.roleMember', 'landing.demo.permView', 'landing.demo.permSend',
  'landing.demo.permReact', 'landing.demo.permManage', 'landing.demo.permAdmin',
  'notifications.someone', 'notifications.unknownServer', 'notifications.unknownChannel', 'notifications.mentionedYou',
  'notifications.channelMessage', 'notifications.dmTitle', 'notifications.announcementInfo', 'notifications.announcementWarning',
  'notifications.announcementMaintenance', 'notifications.announcementGeneric', 'notifications.announcementToast',
  'notifications.announcementMore', 'notifications.dismissAnnouncement',
  'updater.titleAvailable', 'updater.titleDownloading', 'updater.titleReady', 'updater.titleFailed', 'updater.required', 'updater.version',
  'updater.updateNow', 'updater.downloading', 'updater.progress', 'updater.downloaded', 'updater.installed', 'updater.restartNow',
  'updater.failed', 'updater.retry',
  'themes.builtIn.dark', 'themes.builtIn.light', 'themes.builtIn.midnight', 'themes.builtIn.tactical',
  'themes.editor.untitled', 'themes.editor.nameRequired', 'themes.editor.updated', 'themes.editor.created',
  'themes.editor.nameBeforeExport', 'themes.editor.exported', 'themes.editor.livePreview', 'themes.editor.previewInApp',
  'themes.editor.previewInAppHint', 'themes.editor.editTitle', 'themes.editor.name', 'themes.editor.namePlaceholder', 'themes.editor.tags',
  'themes.editor.tagsHint', 'themes.editor.tagsPlaceholder', 'themes.editor.description', 'themes.editor.descriptionPlaceholder',
  'themes.editor.startFrom', 'themes.editor.exportJson', 'themes.editor.update', 'themes.editor.patternsTitle',
  'themes.editor.patternsHint', 'themes.editor.patternType', 'themes.editor.patternColor', 'themes.editor.opacity', 'themes.editor.size',
  'themes.editor.angle', 'themes.editor.svgMarkup', 'themes.editor.svgHint', 'themes.editor.svgCount', 'themes.editor.tileSize',
  'themes.colors.primary', 'themes.colors.secondary', 'themes.colors.tertiary', 'themes.colors.hover', 'themes.colors.active',
  'themes.colors.floating', 'themes.colors.sidebar', 'themes.colors.channelList', 'themes.colors.chatArea', 'themes.colors.muted',
  'themes.colors.links', 'themes.colors.success', 'themes.colors.warning', 'themes.colors.danger', 'themes.colors.info',
  'themes.colors.border', 'themes.colors.connected', 'themes.colors.speaking', 'themes.colors.voiceMuted', 'themes.colors.thumb',
  'themes.colors.thumbHover', 'themes.colors.background', 'themes.colors.text',
  'themes.groups.backgrounds', 'themes.groups.layout', 'themes.groups.text', 'themes.groups.accents', 'themes.groups.borders',
  'themes.groups.voice', 'themes.groups.scrollbar', 'themes.groups.selection',
  'themes.patterns.none', 'themes.patterns.stripes', 'themes.patterns.grid', 'themes.patterns.dots', 'themes.patterns.crosshatch',
  'themes.patterns.customSvg',
  'themes.browser.title', 'themes.browser.available', 'themes.browser.searchPlaceholder', 'themes.browser.sortNewest',
  'themes.browser.sortPopular', 'themes.browser.sortName', 'themes.browser.tagPlaceholder', 'themes.browser.noThemes',
  'themes.browser.noThemesHint', 'themes.browser.loadMore', 'themes.browser.byAuthor', 'themes.browser.installs', 'themes.browser.stop',
  'themes.browser.install', 'themes.browser.uninstall', 'themes.browser.failedToLoad', 'themes.browser.installedToast',
  'themes.browser.uninstalledToast',
  'themes.preview.previewing', 'themes.preview.stop',
  'themes.import.invalidJson', 'themes.import.notAnObject', 'themes.import.missingName', 'themes.import.missingColors',
  'themes.import.invalidColors', 'themes.import.invalidPatterns',
  'appMock.search', 'appMock.onlineCount', 'appMock.lounge', 'appMock.chatWelcome', 'appMock.chatVoiceQuality',
  'appMock.chatNoiseSuppression',
  'roles.deleteRoleQuestion',
];

const REQUIRED_CATEGORIES: Record<string, readonly string[]> = {
  en: ['one', 'other'], fr: ['one', 'other'], de: ['one', 'other'], es: ['one', 'other'], pt: ['one', 'other'],
  ru: ['one', 'few', 'many', 'other'], uk: ['one', 'few', 'many', 'other'],
  ar: ['zero', 'one', 'two', 'few', 'many', 'other'],
  ja: ['other'], ko: ['other'], zh: ['other'],
};

const locales = readdirSync(LOCALE_DIR).filter((f) => f.endsWith('.json')).map((f) => ({
  name: f.replace(/\.json$/, ''),
  bundle: JSON.parse(readFileSync(join(LOCALE_DIR, f), 'utf8')) as Record<string, unknown>,
}));
const en = locales.find((l) => l.name === 'en')!.bundle;

function lookup(bundle: unknown, key: string): unknown {
  return key.split('.').reduce<unknown>((node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined), bundle);
}
const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const resolves = (bundle: unknown, key: string) => isText(lookup(bundle, key)) || isText(lookup(bundle, `${key}_other`));
const placeholders = (text: string) => [...text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort();
/** A key's English text: the plain leaf, or its `_other` form. */
const enText = (key: string) => (lookup(en, key) ?? lookup(en, `${key}_other`)) as string;

const files = SOURCES.map((rel) => ({ rel, text: readFileSync(join(SRC, rel), 'utf8') }));

describe('every key introduced for the hardcoded-text cleanup', () => {
  it('there are 11 locales', () => {
    expect(locales).toHaveLength(11);
  });

  it('exists in all 11 locales', () => {
    const missing = locales.flatMap((l) => NEW_KEYS.filter((k) => !resolves(l.bundle, k)).map((k) => `${l.name}: ${k}`));
    expect(missing).toEqual([]);
  });

  it('names the same {{placeholders}} in every locale', () => {
    const drift = locales.flatMap((l) => NEW_KEYS.flatMap((k) => {
      const leaf = lookup(l.bundle, k);
      const forms = isText(leaf) ? [leaf] : REQUIRED_CATEGORIES[l.name].map((c) => lookup(l.bundle, `${k}_${c}`) as string);
      // Arabic zero/one/two spell the number out, so {{count}} may be absent there
      const expected = placeholders(enText(k)).filter((p) => !(l.name === 'ar' && p === 'count'));
      return forms.filter((f) => !expected.every((p) => placeholders(f ?? '').includes(p))
        || placeholders(f ?? '').some((p) => !placeholders(enText(k)).includes(p))).map(() => `${l.name}: ${k}`);
    }));
    expect(drift).toEqual([]);
  });

  it('a plural family carries every category its language needs', () => {
    const plural = NEW_KEYS.filter((k) => !isText(lookup(en, k)) && isText(lookup(en, `${k}_other`)));
    expect(plural.sort()).toEqual(['themes.browser.available', 'themes.browser.installs']);
    const gaps = locales.flatMap((l) => plural.flatMap((k) => REQUIRED_CATEGORIES[l.name]
      .filter((c) => !isText(lookup(l.bundle, `${k}_${c}`))).map((c) => `${l.name}: ${k}_${c}`)));
    expect(gaps).toEqual([]);
  });

  it('@everyone stays the same token in every language', () => {
    for (const l of locales) expect(lookup(l.bundle, 'chat.mentionEveryone.label'), l.name).toBe('@everyone');
  });
});

describe('the migrated surfaces', () => {
  it('every static key they name resolves in all 11 locales (t, tr and i18n.t alike)', () => {
    const call = /(?<![\w$])(?:t|tr|i18n\.t)\(\s*'([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9_]+)+)'/g;
    const found = files.flatMap(({ rel, text }) => [...text.matchAll(call)].map((m) => ({ rel, key: m[1] })));
    expect(found.length).toBeGreaterThan(150);
    const missing = found.flatMap(({ rel, key }) => locales.filter((l) => !resolves(l.bundle, key)).map((l) => `${l.name}: ${key} (${rel})`));
    expect(missing).toEqual([]);
  });

  it('key tables reached through a variable resolve too (label maps, labelKey fields)', () => {
    const literal = /'((?:themes|landing\.demo|notifications|appMock|updater)\.[A-Za-z0-9_.]+)'/g;
    const found = files.flatMap(({ rel, text }) => [...text.matchAll(literal)].map((m) => ({ rel, key: m[1] })));
    expect(found.length).toBeGreaterThan(50);
    const missing = found.flatMap(({ rel, key }) => locales.filter((l) => !resolves(l.bundle, key)).map((l) => `${l.name}: ${key} (${rel})`));
    expect(missing).toEqual([]);
  });

  it('the built-in theme names are translated (reached as themes.builtIn.${id})', () => {
    const missing = locales.flatMap((l) => BUILT_IN_THEME_IDS.filter((id) => !resolves(l.bundle, `themes.builtIn.${id}`)).map((id) => `${l.name}: ${id}`));
    expect(missing).toEqual([]);
  });

  it("the theme editor's label tables cover every color, group, area and pattern type", () => {
    const editor = files.find((f) => f.rel.endsWith('ThemeEditor.tsx'))!.text;
    const table = (name: string) => {
      const start = editor.indexOf(`export const ${name}`);
      const body = editor.slice(start, editor.indexOf('};', start));
      return new Set([...body.matchAll(/^\s*'?([\w-]+)'?:\s*'[\w.]+',?$/gm)].map((m) => m[1]));
    };
    expect([...THEME_COLOR_KEYS].filter((k) => !table('COLOR_LABEL_KEYS').has(k))).toEqual([]);
    expect(Object.keys(THEME_COLOR_GROUPS).filter((g) => !table('COLOR_GROUP_LABEL_KEYS').has(g))).toEqual([]);
    expect([...THEME_PATTERN_AREAS].filter((a) => !table('AREA_LABEL_KEYS').has(a))).toEqual([]);
    expect([...THEME_PATTERN_TYPES].filter((p) => !table('PATTERN_TYPE_LABEL_KEYS').has(p))).toEqual([]);
  });

  it('the SVG limit is described in characters, which is what validateThemePatterns counts', () => {
    const editor = files.find((f) => f.rel.endsWith('ThemeEditor.tsx'))!.text;
    expect(editor).not.toMatch(/KB &mdash;/);
    for (const l of locales) {
      expect(lookup(l.bundle, 'themes.editor.svgHint'), l.name).not.toMatch(/\bKB\b|\bKo\b|КБ/);
    }
    expect(enText('themes.editor.svgHint')).toContain('characters');
  });

  it('the landing demo no longer offers "Kick": its column reads like the real removal (server.removeAndBan)', () => {
    const landing = files.find((f) => f.rel === 'pages/LandingPage.tsx')!.text;
    expect(landing).not.toMatch(/'Kick'/);
    expect(landing).toContain("'server.removeAndBan'");
  });

  it('the former English literals are gone', () => {
    const FORMER: Array<[string, string]> = [
      ['components/layout/MainLayout.tsx', "'Unknown Server'"],
      ['components/layout/MainLayout.tsx', 'mentioned you in'],
      ['components/layout/MainLayout.tsx', '`DM, ${'],
      ['components/layout/MainLayout.tsx', "'Server was deleted'"],
      ['components/layout/MainLayout.tsx', "'Announcement'"],
      ['components/layout/MainLayout.tsx', "'Ctrl K'"],
      ['utils/notificationAuthor.ts', "'Someone'"],
      ['components/layout/UserCard.tsx', '"Logout"'],
      ['components/chat/MessageList.tsx', 'Welcome to the channel!'],
      ['components/dm/DMCallPanel.tsx', 'Calling...'],
      ['components/updater/UpdateChecker.tsx', 'Update Required'],
      ['components/settings/ThemeEditor.tsx', "'Theme name is required'"],
      ['components/settings/ThemeBrowser.tsx', 'Theme Marketplace'],
      ['components/settings/ThemePreviewBar.tsx', 'Stop Preview'],
      ['components/common/AppShellMock.tsx', 'Alice is typing...'],
      ['stores/supportStore.ts', "'Failed to open support ticket'"],
      ['services/themeEngine.ts', "'Invalid JSON file'"],
      ['pages/LandingPage.tsx', "'Hey, try the new theme!'"],
      ['components/chat/MessageInput.tsx', '`Message #${'],
      ['components/search/SearchModal.tsx', '} at ${'],
      ['components/server/RoleEditor.tsx', "{role.name}</span>? {t('roles.deleteRoleConfirm')}"],
    ];
    const back = FORMER.filter(([rel, literal]) => files.find((f) => f.rel === rel)!.text.includes(literal));
    expect(back).toEqual([]);
  });
});

describe('no hard-coded English anywhere in the desktop app', () => {
  // The legal documents are excluded: their text is maintained as the
  // binding English original (components/legal, CookiePolicyPage).
  const EXCLUDED = /__tests__|[\\/]locales[\\/]|[\\/]components[\\/]legal[\\/]|CookiePolicyPage\.tsx$/;
  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      if (EXCLUDED.test(full)) return [];
      if (statSync(full).isDirectory()) return walk(full);
      return /\.tsx?$/.test(entry) ? [full] : [];
    });
  }
  const all = walk(SRC).map((full) => ({ rel: relative(SRC, full), text: readFileSync(full, 'utf8') }));

  it('no toast is given a literal sentence', () => {
    const hits = all.flatMap(({ rel, text }) => [...text.matchAll(/toast\.\w+\(\s*['`"][A-Za-z][^'`"]*['`"]/g)].map((m) => `${rel}: ${m[0]}`));
    expect(hits).toEqual([]);
  });

  it('no aria-label, title, placeholder or alt is a literal English text (the brand name aside)', () => {
    const hits = all.flatMap(({ rel, text }) => [...text.matchAll(/\b(?:aria-label|title|placeholder|alt)="([A-Za-z][^"]*)"/g)]
      .filter((m) => m[1] !== 'Voxium')
      .map((m) => `${rel}: ${m[0]}`));
    expect(hits).toEqual([]);
  });
});
