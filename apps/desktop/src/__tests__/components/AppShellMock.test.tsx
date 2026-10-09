import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { THEME_COLOR_KEYS } from '@voxium/shared';
import type { ThemeColors, ThemePatterns } from '@voxium/shared';
import { AppShellMock } from '../../components/common/AppShellMock';

/**
 * One shell model, two jobs: the landing hero's product window and the theme
 * editor's live preview. What has to hold:
 *
 *  - `hero` renders exactly what the landing page has always shown (no window
 *    chrome, no People panel) — the marketing shot is not collateral damage of
 *    a settings feature.
 *  - `full` adds the surfaces a theme author needs to judge a palette on: the
 *    title bar (the only thing wearing `sidebar` in the 2026 shell) and the
 *    People panel (the only thing wearing `bg-secondary`).
 *  - Passing `colors` re-scopes the whole subtree, and pattern areas get an
 *    explicit background-image — including `none`, so the ACTIVE theme's own
 *    pattern CSS cannot bleed into a preview of a different theme.
 */

let container: HTMLDivElement;
let root: Root;

function palette(overrides: Partial<Record<string, string>> = {}): ThemeColors {
  const colors: Record<string, string> = {};
  for (const key of THEME_COLOR_KEYS) colors[key] = '#111111';
  return { ...colors, ...overrides } as ThemeColors;
}

function render(node: React.ReactElement) {
  act(() => {
    root.render(node);
  });
}

const find = (selector: string) => container.querySelector(selector);
const shellRoot = () => container.querySelector<HTMLElement>('[data-testid="app-shell-mock"]')!;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('AppShellMock — the shell both consumers draw', () => {
  it('renders the 2026 shell, not the retired vertical rail', () => {
    render(<AppShellMock />);

    const strip = find('[data-testid="app-mock-strip"]');
    expect(strip, 'no spaces strip — this is the 2026 shell, not the old rail').toBeTruthy();
    expect(strip!.textContent).toContain('Voxium HQ');
    expect(find('[data-testid="app-mock-voice-card"]')!.textContent).toContain('Join voice');
    expect(find('[data-testid="app-mock-user-card"]')!.textContent).toContain('Charlie');
    expect(container.querySelector('.w-14'), 'the retired icon rail is back').toBeNull();
  });

  it('keeps the hero variant free of the editor-only surfaces', () => {
    render(<AppShellMock variant="hero" />);

    expect(find('[data-testid="app-mock-titlebar"]')).toBeNull();
    expect(find('[data-testid="app-mock-people"]')).toBeNull();
    // The landing hero draws its OWN title bar; a second one inside the shell
    // would show up as a double header on the marketing page.
    expect(container.querySelector('.bg-vox-sidebar')).toBeNull();
  });

  it('gives the full variant the surfaces a palette has to be judged on', () => {
    render(<AppShellMock variant="full" />);

    // Title bar — the only surface wearing `sidebar` in the 2026 shell.
    const titleBar = find('[data-testid="app-mock-titlebar"]');
    expect(titleBar).toBeTruthy();
    expect(titleBar!.className).toContain('bg-vox-sidebar');
    // People — the only surface wearing `bg-secondary`.
    const people = find('[data-testid="app-mock-people"]');
    expect(people).toBeTruthy();
    expect(people!.className).toContain('bg-vox-bg-secondary');
    expect(people!.textContent).toContain('People');
    // The channel column is what carries `channel` (and its pattern).
    expect(find('[data-testid="app-mock-channels"]')!.className).toContain('bg-vox-channel');
  });

  it('re-scopes the subtree when given a palette', () => {
    render(<AppShellMock variant="full" colors={palette({ chat: '#abcdef', 'accent-primary': '#ff0000' })} />);

    const style = shellRoot().style;
    expect(style.getPropertyValue('--vox-chat')).toBe('#abcdef');
    // Without this one the Tailwind utilities keep rendering the ROOT theme.
    expect(style.getPropertyValue('--color-vox-chat')).toBe('#abcdef');
    expect(style.getPropertyValue('--color-vox-accent-tint')).toContain('#ff0000');
  });

  it('leaves the document theme alone — the preview paints itself only', () => {
    document.documentElement.setAttribute('data-theme', 'midnight');
    render(<AppShellMock variant="full" colors={palette({ chat: '#abcdef' })} />);

    expect(document.documentElement.getAttribute('data-theme')).toBe('midnight');
    expect(document.documentElement.style.getPropertyValue('--vox-chat')).toBe('');
  });

  it('resets pattern areas so the ACTIVE theme cannot bleed into the preview', () => {
    // No patterns authored: the areas still have to say "none" out loud,
    // because [data-theme="tactical"] [class*="bg-vox-chat"] matches in here.
    render(<AppShellMock variant="full" colors={palette()} patterns={{}} />);

    const chat = container.querySelector<HTMLElement>('.bg-vox-chat')!;
    expect(chat.style.backgroundImage).toBe('none');
  });

  it('paints an authored pattern inline', () => {
    const patterns: ThemePatterns = {
      chat: { type: 'grid', color: '#ffffff', opacity: 0.05, size: 40 },
    };
    render(<AppShellMock variant="full" colors={palette()} patterns={patterns} />);

    const chat = container.querySelector<HTMLElement>('.bg-vox-chat')!;
    expect(chat.style.backgroundImage).toContain('linear-gradient');
    expect(chat.style.backgroundSize).toBe('40px 40px');
  });

  it('does NOT touch background-image without a palette (landing keeps its theme patterns)', () => {
    // The tactical theme's claw marks / grid live in stylesheet rules. On the
    // landing page the mock wears the real theme, so overriding here would
    // silently strip a built-in theme's own decoration.
    render(<AppShellMock variant="hero" />);

    const chat = container.querySelector<HTMLElement>('.bg-vox-chat')!;
    expect(chat.style.backgroundImage).toBe('');
  });
});
