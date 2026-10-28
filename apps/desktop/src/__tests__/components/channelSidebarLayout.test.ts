// @vitest-environment node
// Pure filesystem check — no DOM, and jsdom does not give this module a
// file:// import.meta.url to resolve the source directory against.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The channel sidebar's structure (owner, 2026-10-25): a category is a heading
 * over a RAIL of channels (a line down their left), 3 px larger than a section
 * label; the secure-channels section is the same shape and its create control
 * is always visible; the create-category row is a visible dashed row, not a
 * muted line of text. And the strip's active tab names its space in the
 * primary text colour, readable on the light theme's white surface too.
 */

const src = (rel: string) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');
const sidebar = src('components/channel/ChannelSidebar.tsx');
const css = src('styles/globals.css');

describe('channel sidebar — categories, rails and the create controls', () => {
  it('category headings use the larger category label (3px over a section label)', () => {
    expect(css).toMatch(/@utility section-label \{\s*@apply text-\[10\.5px\]/);
    expect(css).toMatch(/@utility category-label \{\s*@apply text-\[13\.5px\]/);
    // the category header button, and the secure section heading
    expect(sidebar).toMatch(/className="category-label[^"]*"\s+data-testid="category-header"/);
    expect(sidebar).toMatch(/<span className="category-label[^"]*">\s*<Lock/);
    // no category heading left on the small label
    expect(sidebar).not.toMatch(/className="section-label/);
  });

  it('every category and the secure section draw a rail down the left of their channels', () => {
    const rails = sidebar.match(/border-l-2 border-vox-border pl-1" data-testid="(category|secure)-rail"/g) ?? [];
    expect(rails.map((r) => r.replace(/.*data-testid="/, '').replace(/"$/, '')).sort()).toEqual(['category-rail', 'secure-rail']);
    // the category rail wraps the children only while the category is open; it
    // sits 5px further right than the secure rail because the category heading
    // starts after its drag grip and chevron (owner, 2026-10-25)
    expect(sidebar).toMatch(/\{!isCollapsed && \(\s*<div className="ml-\[18px\] border-l-2 border-vox-border pl-1" data-testid="category-rail">\s*\{children\}/);
    expect(sidebar).toMatch(/<div className="ml-\[13px\] border-l-2 border-vox-border pl-1" data-testid="secure-rail">/);
  });

  it('the secure-channel create control is always visible, not a hover reveal', () => {
    // the class string of the button whose title is the secure create title
    const classes = sidebar.match(/className="([^"]*)"\s+title=\{t\('secureChannel\.createTitle'\)\}/)![1];
    expect(classes).not.toContain('opacity-0');
    expect(classes).toContain('border');
    expect(classes).toContain('text-vox-accent-primary');
  });

  it('the create-category row is a visible dashed row in the accent colour', () => {
    const classes = sidebar.match(/className="([^"]*)"\s+data-testid="create-category-open"/)![1];
    expect(classes).toContain('border-dashed');
    expect(classes).toContain('text-vox-accent-primary');
    expect(classes).not.toContain('text-vox-text-muted');
  });
});

describe('spaces strip — the active tab names its space readably', () => {
  it('the active tab carries the primary text colour explicitly', () => {
    const strip = src('components/server/SpacesStrip.tsx');
    expect(strip).toMatch(/const activeTab = clsx\('[^']*text-vox-text-primary[^']*'/);
  });
});
