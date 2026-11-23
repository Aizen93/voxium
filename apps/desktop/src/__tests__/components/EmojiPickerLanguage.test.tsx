import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// The picker is given what emoji-picker-react 4.18 lets a host translate, in
// the language of the app: the category names, the preview caption, the search
// placeholder and its clear label; and, for a language the package ships names
// for, its emoji data (loaded on demand, never for English or Arabic).

const { pickerProps } = vi.hoisted(() => ({ pickerProps: { current: null as Record<string, unknown> | null } }));

vi.mock('emoji-picker-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('emoji-picker-react')>();
  return {
    ...actual,
    default: (props: Record<string, unknown>) => {
      pickerProps.current = props;
      return <div data-testid="picker" data-marker={String((props.emojiData as { marker?: string } | undefined)?.marker ?? "")} />;
    },
  };
});

const { loadMock } = vi.hoisted(() => ({ loadMock: vi.fn() }));
vi.mock('../../utils/emojiPickerData', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/emojiPickerData')>();
  loadMock.mockImplementation(actual.loadEmojiData);
  return { ...actual, loadEmojiData: loadMock };
});

import i18n from '../../i18n';
import en from '../../i18n/locales/en.json';
import fr from '../../i18n/locales/fr.json';
import { EmojiPicker } from '../../components/common/EmojiPicker';
import { emojiDataLanguage, EMOJI_DATA_LANGUAGES } from '../../utils/emojiPickerData';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

async function open() {
  const anchor = document.createElement('button');
  document.body.appendChild(anchor);
  const anchorRef = createRef<HTMLElement>();
  (anchorRef as { current: HTMLElement | null }).current = anchor;
  await act(async () => {
    root.render(<EmojiPicker onEmojiSelect={() => {}} onClose={() => {}} anchorRef={anchorRef} />);
  });
  return () => anchor.remove();
}

const names = (p: Record<string, unknown>) => (p.categories as Array<{ category: string; name: string }>).map((c) => [c.category, c.name]);

beforeEach(async () => {
  pickerProps.current = null;
  loadMock.mockClear();
  await i18n.changeLanguage('en');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  act(() => root.unmount());
  container.remove();
  await i18n.changeLanguage('en');
});

describe('EmojiPicker is given its labels in the language of the app', () => {
  it('English: the category names, caption and clear label of the locale, and no emoji data', async () => {
    const cleanup = await open();
    const p = pickerProps.current!;
    expect(names(p)[0]).toEqual(['suggested', en.emojiPickerLabels.category.suggested]);
    expect(names(p)).toHaveLength(9);
    expect((p.previewConfig as { defaultCaption: string }).defaultCaption).toBe(en.emojiPickerLabels.defaultCaption);
    expect(p.searchClearButtonLabel).toBe(en.emojiPickerLabels.clearSearch);
    expect(p.searchPlaceholder).toBe(en.chat.searchEmoji);
    expect(p.emojiData).toBeUndefined();
    expect(loadMock).not.toHaveBeenCalled();
    cleanup();
  });

  it('French: its own names and caption, and the French emoji names once they have loaded', async () => {
    await i18n.changeLanguage('fr');
    const cleanup = await open();
    await vi.waitFor(() => expect(pickerProps.current!.emojiData).toBeDefined());
    const p = pickerProps.current!;
    expect(names(p).map(([, n]) => n)).toEqual(Object.values(fr.emojiPickerLabels.category));
    expect((p.previewConfig as { defaultCaption: string }).defaultCaption).toBe(fr.emojiPickerLabels.defaultCaption);
    expect(p.searchClearButtonLabel).toBe(fr.emojiPickerLabels.clearSearch);
    expect((p.emojiData as { categories: Record<string, unknown> }).categories).toHaveProperty('preview_mood');
    expect(loadMock).toHaveBeenCalledWith('fr');
    cleanup();
  });

  it('changing the language while it is open changes the labels and the data', async () => {
    const cleanup = await open();
    expect(pickerProps.current!.emojiData).toBeUndefined();
    await act(async () => {
      await i18n.changeLanguage('fr');
    });
    await vi.waitFor(() => expect(pickerProps.current!.emojiData).toBeDefined());
    expect(names(pickerProps.current!)[0][1]).toBe(fr.emojiPickerLabels.category.suggested);
    await act(async () => {
      await i18n.changeLanguage('ar');
    });
    expect(pickerProps.current!.emojiData).toBeUndefined();
    cleanup();
  });

  it('Arabic: translated labels, but no emoji data file exists for it, so none is loaded', async () => {
    await i18n.changeLanguage('ar');
    const cleanup = await open();
    expect(names(pickerProps.current!)[0][1]).not.toBe(en.emojiPickerLabels.category.suggested);
    expect(pickerProps.current!.emojiData).toBeUndefined();
    expect(loadMock).not.toHaveBeenCalled();
    cleanup();
  });

  it('a data file that fails to load is logged by message and the picker keeps its English names', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    loadMock.mockRejectedValueOnce(new Error('chunk failed'));
    await i18n.changeLanguage('de');
    const cleanup = await open();
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith('[EmojiPicker] Could not load the emoji names:', 'chunk failed'));
    expect(pickerProps.current!.emojiData).toBeUndefined();
    cleanup();
    warn.mockRestore();
  });
});

describe('emojiDataLanguage', () => {
  it('maps a tag to a shipped data file, never for English or Arabic', () => {
    expect(emojiDataLanguage('fr-CA')).toBe('fr');
    expect(emojiDataLanguage('ZH')).toBe('zh');
    expect(emojiDataLanguage('en')).toBeNull();
    expect(emojiDataLanguage('ar')).toBeNull();
    expect(emojiDataLanguage(undefined)).toBeNull();
    expect(emojiDataLanguage('constructor')).toBeNull();
  });

  it('covers every app language the package has a file for: all but English and Arabic', () => {
    expect([...EMOJI_DATA_LANGUAGES].sort()).toEqual(['de', 'es', 'fr', 'ja', 'ko', 'pt', 'ru', 'uk', 'zh']);
  });
});

describe('the per-language emoji data stays out of the entry chunk', () => {
  it('is only ever imported dynamically', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    for (const rel of ['../../utils/emojiPickerData.ts', '../../components/common/EmojiPicker.tsx']) {
      const src = readFileSync(join(__dirname, rel), 'utf8');
      expect(src, rel).not.toMatch(/^\s*import\s[^;]*from\s*'emoji-picker-react\/dist\/data/m);
      expect(src, rel).not.toMatch(/^\s*import\s+[^;]*\.json'/m);
    }
    const loader = readFileSync(join(__dirname, '../../utils/emojiPickerData.ts'), 'utf8');
    expect((loader.match(/=> import\('emoji-picker-react\/dist\/data\/emojis-[a-z]+'\)/g) ?? []).length).toBe(9);
  });
});

describe('a load that was overtaken', () => {
  it('never lands: the older language resolving last leaves the newer language\'s data', async () => {
    let resolveFr!: (d: unknown) => void;
    loadMock.mockImplementation((language: string) =>
      language === 'fr'
        ? new Promise((resolve) => { resolveFr = resolve; })
        : Promise.resolve({ marker: language, categories: {} }));
    const shown = () => document.body.querySelector('[data-testid="picker"]')?.getAttribute('data-marker');

    await i18n.changeLanguage('fr');
    const cleanup = await open();
    expect(loadMock).toHaveBeenCalledWith('fr');
    await act(async () => {
      await i18n.changeLanguage('de');
    });
    await vi.waitFor(() => expect(shown()).toBe('de'));
    await act(async () => {
      resolveFr({ marker: 'fr', categories: {} });
    });
    expect(shown()).toBe('de');

    // and the other way: back to a language with no data, the late file is not shown
    await act(async () => {
      await i18n.changeLanguage('ar');
    });
    expect(shown()).toBe('');
    cleanup();
  });
});
