import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Privacy rule: no third-party services, no CDNs. The admin shell used to pull
 * Inter from Google Fonts, so every dashboard load leaked the admin's IP and
 * user agent to Google. The font is self-hosted through @fontsource/inter
 * (bundled by Vite, same as the desktop app); this pins both halves.
 */

const ROOT = resolve(__dirname, '../../..');
const html = readFileSync(resolve(ROOT, 'index.html'), 'utf8');
const main = readFileSync(resolve(ROOT, 'src/main.tsx'), 'utf8');
const css = readFileSync(resolve(ROOT, 'src/styles/globals.css'), 'utf8');

describe('admin index.html privacy contract', () => {
  it('loads no <link> or <script> from an external origin', () => {
    const tags = html.match(/<(link|script)\b[^>]*>/gi) ?? [];
    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags) {
      expect(tag, tag).not.toMatch(/(href|src)\s*=\s*["']?\s*(https?:)?\/\//i);
    }
  });

  it('never references Google Fonts or a CDN', () => {
    expect(html).not.toMatch(/googleapis|gstatic|cdn\.|unpkg|jsdelivr/i);
  });

  it('global CSS imports nothing from an external origin', () => {
    expect(css).not.toMatch(/@import\s+(url\()?\s*["']?(https?:)?\/\//i);
    expect(css).not.toMatch(/googleapis|gstatic/i);
  });
});

describe('self-hosted Inter', () => {
  it('main.tsx imports every weight the dashboard uses from @fontsource/inter', () => {
    for (const weight of [300, 400, 500, 600, 700]) {
      expect(main, `weight ${weight}`).toContain(`import '@fontsource/inter/${weight}.css';`);
    }
  });

  it('the theme names Inter first so the bundled face is used', () => {
    expect(css).toMatch(/--font-sans:\s*"Inter",/);
  });
});
