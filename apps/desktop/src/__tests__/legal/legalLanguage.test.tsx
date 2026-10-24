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

const TITLES = {
  privacy: { en: 'Privacy Policy', fr: 'Politique de confidentialité' },
  terms: { en: 'Terms of Service', fr: "Conditions d'utilisation" },
  cookies: { en: 'Cookie Policy', fr: 'Politique de cookies' },
} as const;

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
    expect(container.querySelector('header')?.textContent).toContain(TITLES[name].fr);
    expect(container.textContent).toContain("Retour à l'accueil");
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
