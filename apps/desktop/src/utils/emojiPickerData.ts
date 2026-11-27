import type { EmojiData } from 'emoji-picker-react/dist/types/exposedTypes';

/**
 * The emoji names the picker searches in, per language (what emoji-picker-react
 * 4.18 ships under dist/data: about 190 to 295 KB of JSON each). Each file is a
 * dynamic import, so it is a chunk of its own that is fetched only when the
 * picker opens in that language; English is the picker's own built-in data.
 *
 * Arabic has no file in 4.18: the picker's names stay English there, only its
 * labels (the component translates those itself) follow the language.
 */
const LOADERS: Record<string, () => Promise<{ default: EmojiData }>> = {
  de: () => import('emoji-picker-react/dist/data/emojis-de'),
  es: () => import('emoji-picker-react/dist/data/emojis-es'),
  fr: () => import('emoji-picker-react/dist/data/emojis-fr'),
  ja: () => import('emoji-picker-react/dist/data/emojis-ja'),
  ko: () => import('emoji-picker-react/dist/data/emojis-ko'),
  pt: () => import('emoji-picker-react/dist/data/emojis-pt'),
  ru: () => import('emoji-picker-react/dist/data/emojis-ru'),
  uk: () => import('emoji-picker-react/dist/data/emojis-uk'),
  zh: () => import('emoji-picker-react/dist/data/emojis-zh'),
};

/** The language of the data file for an app language tag ("fr-CA" is "fr"), or null */
export function emojiDataLanguage(language: string | undefined | null): string | null {
  const base = (language ?? '').toLowerCase().split('-')[0];
  return Object.hasOwn(LOADERS, base) ? base : null;
}

/** The languages that have emoji names to load */
export const EMOJI_DATA_LANGUAGES = Object.keys(LOADERS);

const loaded = new Map<string, Promise<EmojiData>>();

/**
 * The emoji data of a language, once; a failure is not kept (the next open
 * tries again) and is thrown to the caller, which logs it.
 */
export function loadEmojiData(language: string): Promise<EmojiData> {
  const held = loaded.get(language);
  if (held) return held;
  const loader = Object.hasOwn(LOADERS, language) ? LOADERS[language] : null;
  if (!loader) return Promise.reject(new Error(`No emoji data for ${language}`));
  const promise = loader().then((m) => m.default);
  loaded.set(language, promise);
  promise.catch(() => loaded.delete(language));
  return promise;
}
