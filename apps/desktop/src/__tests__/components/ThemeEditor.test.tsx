import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { THEME_COLOR_KEYS, THEME_COLOR_GROUPS } from '@voxium/shared';
import type { CommunityThemeData, ThemeColors } from '@voxium/shared';
import { ThemeEditor } from '../../components/settings/ThemeEditor';
import { clearCustomThemeColors } from '../../services/themeEngine';
import { useSettingsStore } from '../../stores/settingsStore';

/**
 * The theme editor's preview surface. Three things it owes the author:
 *
 *  1. The mock shows the CURRENT app (the 2026 shell), not the retired
 *     three-column layout — a preview of a UI that no longer exists is worse
 *     than no preview, because it is believed.
 *  2. The palette being authored paints the preview and NOTHING else, until
 *     the author explicitly asks for the whole app.
 *  3. "Preview in app" is reversible from every exit: the Stop button, Escape,
 *     and closing the editor mid-preview. A theme the user never chose must
 *     never survive on <html>.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let settingsModal: HTMLDivElement;
const onClose = vi.fn();

const find = (selector: string) => document.body.querySelector<HTMLElement>(selector);
const text = () => document.body.textContent ?? '';

/**
 * A real palette to open on. jsdom resolves no stylesheets, so the editor's
 * usual "start from the brand theme" read of the computed `--vox-*` values
 * comes back empty — the prefill path gives the assertions actual colors.
 */
function draftTheme(): CommunityThemeData {
  const colors: Record<string, string> = {};
  for (const key of THEME_COLOR_KEYS) colors[key] = '#101020';
  colors.chat = '#abcdef';
  colors['accent-primary'] = '#ff0000';
  // The 2026 palettes make these layers translucent by design — the editor has
  // to carry that through rather than flatten it.
  colors['bg-hover'] = 'rgba(141, 141, 242, 0.08)';
  colors.border = 'rgba(141, 141, 242, 0.12)';
  return {
    name: 'Draft',
    description: '',
    tags: [],
    colors: colors as ThemeColors,
    version: 1,
  };
}

function mount() {
  act(() => {
    root.render(<ThemeEditor onClose={onClose} initialData={draftTheme()} />);
  });
}

function click(el: Element | null) {
  act(() => {
    el!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/** React tracks the last value it wrote, so a bare `.value =` is ignored. */
function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  useSettingsStore.setState({ theme: 'midnight', customThemes: [] });
  // A test that saves a theme paints it onto <html>; wipe those inline
  // properties so the next test starts on a document wearing nothing custom.
  clearCustomThemeColors();
  document.documentElement.setAttribute('data-theme', 'midnight');
  // Stands in for the settings modal the editor is opened from.
  settingsModal = document.createElement('div');
  settingsModal.id = 'vox-settings-modal';
  document.body.appendChild(settingsModal);

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  settingsModal.remove();
  onClose.mockClear();
  useSettingsStore.setState({ theme: 'dark', customThemes: [] });
});

describe('theme editor color fields', () => {
  const row = (key: string) => find(`[data-color-key="${key}"]`);
  const textField = (key: string) => row(key)!.querySelector<HTMLInputElement>('input[type="text"]')!;
  const swatch = (key: string) => row(key)!.querySelector<HTMLInputElement>('input[type="color"]')!;

  /** Only one color group is open at a time; open the one holding `key`. */
  function reveal(key: string) {
    if (row(key)) return;
    const group = Object.entries(THEME_COLOR_GROUPS).find(([, keys]) =>
      (keys as readonly string[]).includes(key),
    )!;
    click([...document.body.querySelectorAll('button')].find((b) => b.textContent?.startsWith(group[0]))!);
  }

  /**
   * Focus → type → blur, which is when the field commits. Real focus()/blur()
   * calls, not synthetic FocusEvents: React delegates onFocus/onBlur from
   * `focusin`/`focusout`, and a hand-built non-bubbling `focus` never reaches
   * it — the handlers would silently never run and every assertion here would
   * pass vacuously.
   */
  function edit(key: string, value: string) {
    const input = textField(key);
    act(() => input.focus());
    type(input, value);
    act(() => input.blur());
  }

  it('shows a translucent layer as rgba() instead of flattening it to hex', () => {
    // The other half of the publishing bug: the editor only knew about
    // `selection-*`, so opening a theme with a translucent hover and touching
    // it dropped the alpha the 2026 palettes are built on.
    mount();
    expect(textField('bg-hover').value).toBe('rgba(141, 141, 242, 0.08)');
    reveal('border');
    expect(textField('border').value).toBe('rgba(141, 141, 242, 0.12)');
    // Opaque surfaces still read as hex.
    reveal('chat');
    expect(textField('chat').value).toBe('#abcdef');
  });

  it('keeps the alpha when the swatch changes the color', () => {
    mount();
    act(() => {
      const el = swatch('bg-hover');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(el, '#ff0000');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(textField('bg-hover').value).toBe('rgba(255, 0, 0, 0.08)');
  });

  it('refuses a typed value the marketplace would reject', () => {
    mount();
    edit('bg-hover', 'rgba(300, 0, 0, 5)');
    expect(textField('bg-hover').value, 'garbage was committed into the draft').toBe(
      'rgba(141, 141, 242, 0.08)',
    );

    // A good value still lands.
    edit('bg-hover', 'rgba(0, 128, 255, 0.2)');
    expect(textField('bg-hover').value).toBe('rgba(0, 128, 255, 0.2)');

    // …and rgba on an opaque surface is not offered at all.
    reveal('chat');
    edit('chat', 'rgba(0, 0, 0, 0.5)');
    expect(textField('chat').value).toBe('#abcdef');
  });

  it('saves the alpha it was given, so the theme can be published', () => {
    mount();
    type(find('input[type="text"]') as HTMLInputElement, 'Translucent');
    click([...document.body.querySelectorAll('button')].find((b) => b.textContent?.includes('Save'))!);

    const saved = useSettingsStore.getState().customThemes[0];
    expect(saved.data.colors['bg-hover']).toBe('rgba(141, 141, 242, 0.08)');
    expect(saved.data.colors['border']).toBe('rgba(141, 141, 242, 0.12)');
  });
});

describe('theme editor live preview', () => {
  it('previews the current app shell, not the retired layout', () => {
    mount();

    const preview = find('[data-testid="theme-editor-shell-preview"]');
    expect(preview, 'no live preview panel').toBeTruthy();
    expect(preview!.querySelector('[data-testid="app-shell-mock"]')).toBeTruthy();
    // The 2026 shell: spaces strip on top, People panel, window chrome.
    expect(preview!.querySelector('[data-testid="app-mock-strip"]')).toBeTruthy();
    expect(preview!.querySelector('[data-testid="app-mock-people"]')).toBeTruthy();
    expect(preview!.querySelector('[data-testid="app-mock-titlebar"]')).toBeTruthy();
    // The retired mock's channel list ("# general / # random / # links").
    expect(text(), 'the pre-redesign mini preview is still being drawn').not.toContain('# random');
  });

  it('paints the edited palette into the preview only, never onto the app', () => {
    mount();

    const shell = find('[data-testid="app-shell-mock"]')!;
    // Scoped to the mock's own subtree — and in BOTH namespaces, or the
    // Tailwind utilities inside it would keep rendering the root theme.
    expect(shell.style.getPropertyValue('--vox-chat')).toBe('#abcdef');
    expect(shell.style.getPropertyValue('--color-vox-chat')).toBe('#abcdef');
    // …and the document is still wearing whatever the user actually chose.
    expect(document.documentElement.getAttribute('data-theme')).toBe('midnight');
    expect(document.documentElement.style.getPropertyValue('--vox-chat')).toBe('');
  });
});

describe('theme editor "preview in app"', () => {
  const previewButton = () => find('[data-testid="theme-editor-preview-app"]');
  const previewBar = () => find('[data-testid="theme-preview-bar"]');

  it('applies the draft to the whole app and gets every dialog out of the way', () => {
    mount();
    click(previewButton());

    expect(document.documentElement.getAttribute('data-theme')).toBe('custom');
    expect(previewBar(), 'nothing tells the user they are in preview').toBeTruthy();
    expect(settingsModal.style.display).toBe('none');
    // The editor stays MOUNTED (its state is the theme being authored) but
    // must not be on screen while the app is being judged.
    // `visibility`, not `display`: display:none cancels the mock's CSS
    // animations, so returning from a preview replayed the whole chat fade-in.
    expect(find('.fixed.inset-0')!.style.visibility).toBe('hidden');
  });

  it('keeps the authored palette across a preview round-trip', () => {
    mount();
    type(find('input[type="text"]') as HTMLInputElement, 'Sunset');

    click(previewButton());
    expect(previewBar()!.textContent).toContain('Sunset');

    click(previewBar()!.querySelector('button'));
    // Re-mounting the form on every preview would have wiped this.
    expect((find('input[type="text"]') as HTMLInputElement).value).toBe('Sunset');
  });

  it('puts the real theme back when preview stops', () => {
    mount();
    click(previewButton());
    click(previewBar()!.querySelector('button'));

    expect(document.documentElement.getAttribute('data-theme')).toBe('midnight');
    expect(previewBar()).toBeNull();
    expect(settingsModal.style.display).toBe('');
    expect(find('.fixed.inset-0')!.style.visibility).toBe('visible');
  });

  it('stops on Escape', () => {
    mount();
    click(previewButton());

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(document.documentElement.getAttribute('data-theme')).toBe('midnight');
    expect(previewBar()).toBeNull();
  });

  it('restores the theme if the editor is closed mid-preview', () => {
    // The regression that would otherwise ship a stranger's colors
    // permanently: the store still says "midnight", so nothing would ever
    // re-apply it on its own.
    mount();
    click(previewButton());
    expect(document.documentElement.getAttribute('data-theme')).toBe('custom');

    act(() => root.unmount());

    expect(document.documentElement.getAttribute('data-theme')).toBe('midnight');
    expect(settingsModal.style.display).toBe('');

    // afterEach unmounts again; make that a no-op.
    root = createRoot(container);
  });

  it('hands the app over to the store on save instead of undoing it', () => {
    mount();
    type(find('input[type="text"]') as HTMLInputElement, 'Sunset');
    click(previewButton());

    const save = [...document.body.querySelectorAll('button')].find((b) => b.textContent?.includes('Save'));
    click(save!);

    // Saved theme is the ACTIVE theme — not a rollback to midnight.
    expect(useSettingsStore.getState().theme.startsWith('custom:')).toBe(true);
    expect(document.documentElement.getAttribute('data-theme')).toBe('custom');
    expect(onClose).toHaveBeenCalled();
    expect(settingsModal.style.display).toBe('');
  });
});
