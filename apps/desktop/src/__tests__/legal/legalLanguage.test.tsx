import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import i18n, { SUPPORTED_LANGUAGES } from '../../i18n';
import { legalLanguageFor } from '../../components/legal/legalLanguage';
import { PrivacyContent } from '../../components/legal/PrivacyContent';
import { TermsContent } from '../../components/legal/TermsContent';
import { CookiePolicyContent } from '../../components/legal/CookiePolicyContent';
import { LegalDocModal } from '../../components/legal/LegalDocModal';
import { CookiePolicyPage } from '../../pages/CookiePolicyPage';
import { PrivacyPage } from '../../pages/PrivacyPage';
import { TermsPage } from '../../pages/TermsPage';

/**
 * The legal documents follow the app language: French when it is French,
 * English for every other language (the documents exist in those two only,
 * components/legal/legalLanguage.ts). Driven through the app's real i18n
 * instance, so a change to how it resolves a language (load: 'languageOnly',
 * the fallback) is covered too.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The documents' own <h1> (the French text elides with ’). */
const TITLES = {
  privacy: { en: 'Privacy Policy', fr: 'Politique de confidentialité' },
  terms: { en: 'Terms of Service', fr: 'Conditions d’utilisation' },
  cookies: { en: 'Cookie Policy', fr: 'Politique de cookies' },
} as const;

/** The page chrome's titles, from the locale files. */
const CHROME_TITLE_KEYS = {
  privacy: 'landing.footer.privacyPolicy',
  terms: 'landing.footer.termsOfService',
  cookies: 'landing.footer.cookiePolicy',
} as const;

const NOTICE_KEY = 'legal.englishVersionNotice';
const notice = () => container.querySelector('[data-testid="legal-language-notice"]');

const DOCUMENTS = {
  privacy: <PrivacyContent />,
  terms: <TermsContent />,
  cookies: <CookiePolicyContent />,
} as const;
const documentNames = Object.keys(DOCUMENTS) as Array<keyof typeof DOCUMENTS>;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  // The public pages scroll to the top on mount; jsdom does not implement it
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await i18n.changeLanguage('en');
  try {
    localStorage.removeItem('voxium_language');
  } catch (err) {
    console.warn('could not clear the stored test language', err);
  }
});

async function setLanguage(code: string) {
  await act(async () => {
    await i18n.changeLanguage(code);
  });
}

function show(element: ReactElement) {
  act(() => root.render(element));
}

const h1 = () => container.querySelector('h1')?.textContent;

describe('legalLanguageFor', () => {
  it('reads every French tag as French', () => {
    for (const tag of ['fr', 'FR', 'fr-FR', 'fr-CA', 'fr_BE']) expect(legalLanguageFor(tag), tag).toBe('fr');
  });

  it('reads every other tag, and none, as English', () => {
    for (const tag of ['en', 'en-US', 'es', 'de', 'ar', 'zh', 'fro', 'afr', '', undefined]) {
      expect(legalLanguageFor(tag), String(tag)).toBe('en');
    }
  });
});

describe('the legal documents follow the app language', () => {
  const cases = SUPPORTED_LANGUAGES.flatMap(({ code }) => documentNames.map((name) => [name, code] as const));

  it.each(cases)('%s in %s', async (name, code) => {
    await setLanguage(code);
    show(DOCUMENTS[name]);
    const lang = code === 'fr' ? 'fr' : 'en';
    expect(h1()).toBe(TITLES[name][lang]);
    // the document says which language it is written in, whatever <html lang> says
    expect(container.firstElementChild?.getAttribute('lang')).toBe(lang);
  });

  it('reads a regional French tag as French', async () => {
    await setLanguage('fr-CA');
    show(<PrivacyContent />);
    expect(h1()).toBe(TITLES.privacy.fr);
  });

  it('switches with the app language while open', async () => {
    await setLanguage('en');
    show(<TermsContent />);
    expect(h1()).toBe(TITLES.terms.en);
    await setLanguage('fr');
    expect(h1()).toBe(TITLES.terms.fr);
    await setLanguage('de');
    expect(h1()).toBe(TITLES.terms.en);
  });

  it('the consent modal shows the document in French, under its French title', async () => {
    await setLanguage('fr');
    show(<LegalDocModal doc="privacy" onClose={() => {}} />);
    expect(container.querySelector('#legal-doc-title')?.textContent).toBe(TITLES.privacy.fr);
    expect(h1()).toBe(TITLES.privacy.fr);
  });

  it.each([
    ['cookies', <CookiePolicyPage />],
    ['privacy', <PrivacyPage />],
    ['terms', <TermsPage />],
  ] as const)('the public %s page puts the French document in French chrome', async (name, page) => {
    await setLanguage('fr');
    show(<MemoryRouter>{page}</MemoryRouter>);
    expect(h1()).toBe(TITLES[name].fr);
    expect(container.querySelector('header')?.textContent).toContain(i18n.t(CHROME_TITLE_KEYS[name]));
    expect(container.textContent).toContain(i18n.t('landing.footer.backToHome'));
    expect(container.textContent).not.toContain('Back to home');
  });

  it('the public cookie page keeps its English chrome in English', async () => {
    await setLanguage('en');
    show(<MemoryRouter><CookiePolicyPage /></MemoryRouter>);
    expect(h1()).toBe(TITLES.cookies.en);
    expect(container.querySelector('header')?.textContent).toContain('Cookie Policy');
    expect(container.textContent).toContain('Back to home');
  });
});

describe('a language with no translation says the English is shown', () => {
  it.each(['de', 'ja'])('shows the notice in %s, in that language, above the English document', async (code) => {
    await setLanguage(code);
    show(<PrivacyContent />);
    const shown = notice();
    expect(shown).toBeTruthy();
    expect(shown!.textContent).toBe(i18n.getResource(code, 'translation', NOTICE_KEY));
    expect(shown!.textContent).not.toBe(i18n.getResource('en', 'translation', NOTICE_KEY));
    expect(shown!.getAttribute('lang')).toBe(code);
    // above the document, inside the English wrapper
    expect(shown!.parentElement?.getAttribute('lang')).toBe('en');
    expect(shown!.nextElementSibling?.tagName).toBe('H1');
  });

  it('under Arabic, lays the English document out left to right and keeps the notice right to left', async () => {
    await setLanguage('ar');
    show(<TermsContent />);
    const wrapper = container.firstElementChild;
    expect(wrapper?.getAttribute('lang')).toBe('en');
    expect(wrapper?.getAttribute('dir')).toBe('ltr');
    expect(notice()?.getAttribute('dir')).toBe('rtl');
    expect(notice()?.getAttribute('lang')).toBe('ar');
  });

  it.each(['de', 'en', 'fr'])('sets no direction in %s', async (code) => {
    await setLanguage(code);
    show(<TermsContent />);
    expect(container.firstElementChild?.hasAttribute('dir')).toBe(false);
    expect(notice()?.hasAttribute('dir') ?? false).toBe(false);
  });

  it.each(documentNames)('the %s carries it too', async (name) => {
    await setLanguage('es');
    show(DOCUMENTS[name]);
    expect(notice()?.textContent).toBe(i18n.getResource('es', 'translation', NOTICE_KEY));
  });

  it.each(['en', 'fr', 'fr-CA'])('shows no notice in %s', async (code) => {
    await setLanguage(code);
    for (const name of documentNames) {
      show(DOCUMENTS[name]);
      expect(notice(), `${name} in ${code}`).toBeNull();
    }
  });

  it('the notice exists in all 11 locales, translated', () => {
    expect(SUPPORTED_LANGUAGES).toHaveLength(11);
    const english = i18n.getResource('en', 'translation', NOTICE_KEY) as unknown;
    expect(english).toBe('This document is available in English and French. The English version is shown below.');
    for (const { code } of SUPPORTED_LANGUAGES) {
      const text = i18n.getResource(code, 'translation', NOTICE_KEY) as unknown;
      expect(typeof text === 'string' && text.length > 0, code).toBe(true);
      if (code !== 'en') expect(text, code).not.toBe(english);
    }
  });
});
