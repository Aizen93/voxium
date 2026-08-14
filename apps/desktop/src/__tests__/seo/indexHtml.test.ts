import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The SPA shell is the ONLY HTML crawlers and link previews ever see, so its
 * head is load-bearing: the site was effectively invisible (bare <title>, no
 * description, no Open Graph) and shipped zero crawlable content. This pins
 * the whole contract — meta tags, structured data, static landing copy in
 * #root, and the privacy rule that no third-party host appears in the shell.
 */

const ROOT = resolve(__dirname, '../../..');
const html = readFileSync(resolve(ROOT, 'index.html'), 'utf8');

describe('index.html SEO contract', () => {
  it('carries the title and description', () => {
    expect(html).toContain('<title>Voxium — Privacy-First Real-Time Communication Platform</title>');
    expect(html).toMatch(/<meta name="description" content="Privacy-first voice, video, chat and screen sharing\./);
    expect(html).toContain('<link rel="canonical" href="https://voxium.app/"');
  });

  it('carries the full Open Graph card', () => {
    for (const prop of ['og:title', 'og:description', 'og:image', 'og:url', 'og:type', 'og:site_name']) {
      expect(html, prop).toContain(`property="${prop}"`);
    }
    expect(html).toContain('content="https://voxium.app/og-image.png"');
  });

  it('carries the Twitter card', () => {
    expect(html).toContain('name="twitter:card" content="summary_large_image"');
    for (const name of ['twitter:title', 'twitter:description', 'twitter:image']) {
      expect(html, name).toContain(`name="${name}"`);
    }
  });

  it('carries valid SoftwareApplication structured data', () => {
    const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    expect(m, 'JSON-LD block present').toBeTruthy();
    const data = JSON.parse(m![1]);
    expect(data['@type']).toBe('SoftwareApplication');
    expect(data.name).toBe('Voxium');
    expect(data.url).toBe('https://voxium.app');
  });

  it('ships crawlable landing content inside #root, not an empty div', () => {
    expect(html).toContain('<h1>Voxium — Privacy-First Real-Time Communication Platform</h1>');
    // Crawlers must find real substance and the important links without JS.
    expect(html).toContain('Why communities choose Voxium');
    for (const href of ['/register', '/login', '/privacy', '/terms']) {
      expect(html, href).toContain(`href="${href}"`);
    }
  });

  it('drops the marketing shell on non-landing routes', () => {
    // The inline script keeps /login and /app from flashing landing copy.
    expect(html).toMatch(/location\.pathname !== '\/'/);
  });

  it('makes no pricing promises the roadmap cannot keep', () => {
    // ROADMAP.md §9: free for individuals, resource-based tiers for big
    // communities, self-hosting always free. "Free forever" / "nothing to
    // buy" style claims contradict the planned Plus and server tiers.
    expect(html).not.toMatch(/forever|nothing to buy|always be free|free for everyone/i);
  });

  it('makes no open-source claim — Voxium is source-available (VCL-1.0)', () => {
    // Since the relicense from AGPL (NOTICE.md), "open source" would be an
    // openwashing claim the license cannot back. Say "source-available".
    expect(html).not.toMatch(/open[- ]source/i);
  });

  it('references no third-party hosts — fonts are self-hosted', () => {
    // Privacy rule: visitors must not ping Google (or anyone) to render the shell.
    expect(html).not.toMatch(/fonts\.googleapis|fonts\.gstatic|cdn\.|unpkg|jsdelivr/);
  });

  it('has the crawler support files and the OG image on disk', () => {
    expect(existsSync(resolve(ROOT, 'public/robots.txt'))).toBe(true);
    expect(existsSync(resolve(ROOT, 'public/sitemap.xml'))).toBe(true);
    expect(existsSync(resolve(ROOT, 'public/og-image.png'))).toBe(true);
  });
});
