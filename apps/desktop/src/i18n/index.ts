import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

import en from './locales/en.json';
import fr from './locales/fr.json';
import es from './locales/es.json';
import pt from './locales/pt.json';
import de from './locales/de.json';
import ru from './locales/ru.json';
import uk from './locales/uk.json';
import ko from './locales/ko.json';
import zh from './locales/zh.json';
import ja from './locales/ja.json';
import ar from './locales/ar.json';

export const SUPPORTED_LANGUAGES = [
  { code: 'en', name: 'English', nativeName: 'English' },
  { code: 'fr', name: 'French', nativeName: 'Français' },
  { code: 'es', name: 'Spanish', nativeName: 'Español' },
  { code: 'pt', name: 'Portuguese', nativeName: 'Português' },
  { code: 'de', name: 'German', nativeName: 'Deutsch' },
  { code: 'ru', name: 'Russian', nativeName: 'Русский' },
  { code: 'uk', name: 'Ukrainian', nativeName: 'Українська' },
  { code: 'ko', name: 'Korean', nativeName: '한국어' },
  { code: 'zh', name: 'Chinese', nativeName: '中文' },
  { code: 'ja', name: 'Japanese', nativeName: '日本語' },
  { code: 'ar', name: 'Arabic', nativeName: 'العربية', dir: 'rtl' as const },
] as const;

export type LanguageCode = (typeof SUPPORTED_LANGUAGES)[number]['code'];

const RTL_LANGUAGES = new Set(['ar']);

export function isRTL(lang: string): boolean {
  return RTL_LANGUAGES.has(lang);
}

/** Apply document direction based on language.
 *  Only set dir="rtl" explicitly — for LTR languages, remove the attribute
 *  so the browser uses its default. Setting dir="ltr" explicitly can cause
 *  Tailwind 4 to switch utilities to logical properties, altering layout. */
export function applyLanguageDirection(lang: string) {
  if (isRTL(lang)) {
    document.documentElement.dir = 'rtl';
  } else {
    document.documentElement.removeAttribute('dir');
  }
  document.documentElement.lang = lang;
}

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      fr: { translation: fr },
      es: { translation: es },
      pt: { translation: pt },
      de: { translation: de },
      ru: { translation: ru },
      uk: { translation: uk },
      ko: { translation: ko },
      zh: { translation: zh },
      ja: { translation: ja },
      ar: { translation: ar },
    },
    fallbackLng: 'en',
    // Strip region subtags so detected "fr-FR" becomes "fr", matching our
    // resource keys and SUPPORTED_LANGUAGES codes. Without this, i18n.language
    // holds the full BCP-47 tag (e.g. "fr-FR") which breaks <select> value
    // matching, RTL detection for "ar-*" variants, etc.
    load: 'languageOnly',
    interpolation: {
      escapeValue: false,
    },
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: 'voxium_language',
      caches: ['localStorage'],
    },
  });

// Apply direction on init
applyLanguageDirection(i18n.language);

// Apply direction on language change
i18n.on('languageChanged', (lang) => {
  applyLanguageDirection(lang);
});

export default i18n;
