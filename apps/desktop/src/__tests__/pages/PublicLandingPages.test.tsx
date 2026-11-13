import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SupporterAcknowledgments } from '../../components/landing/PublicPageContent';
import i18n, { SUPPORTED_LANGUAGES } from '../../i18n';
import { LandingPage } from '../../pages/LandingPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  await i18n.changeLanguage('en');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: true, data: {} }))));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('public landing pages', () => {
  it.each(['/', '/architecture', '/contributors'])('scrolls to the hero on every home-link click from %s', async (initialPath) => {
    vi.stubGlobal('IntersectionObserver', class {
      observe() {}
      disconnect() {}
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    await act(async () => root.render(
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/architecture" element={<LandingPage page="architecture" />} />
          <Route path="/contributors" element={<LandingPage page="contributors" />} />
        </Routes>
      </MemoryRouter>,
    ));
    const scroll = vi.fn(function (this: HTMLElement) { return this.id; });
    const restore = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scroll });

    try {
      await act(async () => container.querySelector<HTMLAnchorElement>('nav a[href="/#hero"]')!.click());
      expect(container.querySelector('#hero')).not.toBeNull();
      for (const region of ['nav', 'footer', 'footer']) {
        await act(async () => container.querySelector<HTMLAnchorElement>(region + ' a[href="/#hero"]')!.click());
      }
      expect(scroll.mock.results.map(({ value }) => value)).toEqual(['hero', 'hero', 'hero', 'hero']);
    } finally {
      if (restore) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', restore);
      else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
    }
  });

  it.each([
    ["en","infrastructure","self-hosted","private audio"] as const,
    ["fr","infrastructure","auto-hébergé","audio de l’appel privé"] as const,
    ["de","Infrastruktur","selbst gehostete","Ton des privaten Anrufs"] as const,
    ["es","infraestructura","autoalojado","audio de la llamada privada"] as const,
    ["pt","infraestrutura","auto-hospedado","áudio privado"] as const,
    ["ru","инфраструктуру","размещает самостоятельно","звуком личного звонка"] as const,
    ["uk","інфраструктуру","розміщує самостійно","звуком приватного дзвінка"] as const,
    ["zh","基础设施","自托管","私密音频"] as const,
    ["ja","インフラ","セルフホスト","プライベート通話の音声"] as const,
    ["ko","인프라","자체 호스팅","비공개 오디오"] as const,
    ["ar","البنية التحتية","ذاتية الاستضافة","الصوت الخاص"] as const,
  ])('preserves infrastructure, self-hosting, and private audio terminology in %s', (locale, infrastructure, selfHosted, privateAudio) => {
    const copy = i18n.getResource(locale, 'translation', 'landing.publicPages.architecturePage');
    expect(copy.intro).toContain(infrastructure);
    expect(copy.notes.stun.detail).toContain(selfHosted);
    expect(copy.flows.private.detail).toContain(privateAudio);
  });

  it('sets the canonical URL for each public page and restores the home URL on unmount', () => {
    const canonical = document.createElement('link');
    canonical.rel = 'canonical';
    canonical.href = 'https://voxium.app/';
    document.head.append(canonical);

    try {
      for (const page of ['architecture', 'contributors'] as const) {
        act(() => root.render(<MemoryRouter><LandingPage page={page} /></MemoryRouter>));
        expect(canonical.getAttribute('href')).toBe(`https://voxium.app/${page}`);
      }
      act(() => root.render(null));
      expect(canonical.getAttribute('href')).toBe('https://voxium.app/');
    } finally {
      canonical.remove();
    }
  });

  it('describes transport protocols without naming the hosting setup in any locale', () => {
    for (const { code } of SUPPORTED_LANGUAGES) {
      const copy = i18n.getResource(code, 'translation', 'landing.publicPages');
      expect(JSON.stringify(copy), code).not.toMatch(/nginx/i);
      expect(copy.architecturePage.routes.api.transport, code).toContain('TLS');
      expect(copy.architecturePage.routes.events.transport, code).toMatch(/^(?=.*WebSocket)(?=.*TLS)/);
      expect(copy.architecturePage.routes.media.transport, code).toBe('WebRTC');
    }
  });

  it('provides every public-page string in all supported languages', () => {
    const populatedKeys = (branch: Record<string, unknown>): string[] => Object.entries(branch).flatMap(([key, value]) =>
      typeof value === 'string'
        ? (value.trim() ? [key] : [])
        : populatedKeys(value as Record<string, unknown>).map((child) => `${key}.${child}`),
    );
    const english = i18n.getResource('en', 'translation', 'landing.publicPages');
    const keys = populatedKeys(english).sort();
    for (const { code } of SUPPORTED_LANGUAGES) {
      const localized = i18n.getResource(code, 'translation', 'landing.publicPages');
      expect(populatedKeys(localized).sort(), code).toEqual(keys);
      expect(localized.contributorsPage.profileLabel, code).toContain('{{username}}');
    }
  });

  it('offers all connection flows, resets highlights, and links to the public architecture document', () => {
    const originalTitle = document.title;
    act(() => root.render(
      <MemoryRouter initialEntries={['/architecture']}><LandingPage page="architecture" /></MemoryRouter>,
    ));
    expect(document.title).toBe('Architecture | Voxium');
    expect(container.querySelector('main h1')?.textContent).toBe('How Voxium works.');
    expect(container.querySelector('nav a[aria-current="page"]')?.getAttribute('href')).toBe('/architecture');
    expect(container.querySelector('main a')?.getAttribute('href')).toBe(
      'https://github.com/Aizen93/voxium/blob/main/Architecture.md',
    );

    const buttons = [...container.querySelectorAll<HTMLButtonElement>('.lp-public-flow-controls button')];
    const cases = [
      { label: 'Send a message', services: ['api', 'events'], storage: ['PostgreSQL'], detail: 'PostgreSQL' },
      { label: 'Join group voice', services: ['events', 'media'], storage: ['Redis'], detail: 'Redis tracks voice state' },
      { label: 'Make a private call', services: ['events', 'peer'], storage: [], detail: 'directly over WebRTC' },
      { label: 'Overview', services: [], storage: [], detail: 'HTTPS carries requests' },
    ];
    for (const { label, services, storage, detail } of cases) {
      const selected = buttons.find((button) => button.textContent === label)!;
      act(() => selected.click());
      expect(buttons.filter((button) => button.getAttribute('aria-pressed') === 'true')).toEqual([selected]);
      expect([...container.querySelectorAll('.lp-public-destination[data-active="true"]')]
        .map((node) => node.parentElement?.dataset.route)).toEqual(services);
      expect([...container.querySelectorAll('.lp-public-data [data-active="true"] strong')]
        .map((node) => node.textContent)).toEqual(storage);
      expect(container.querySelector('figcaption')?.textContent).toContain(detail);
    }
    act(() => root.render(null));
    expect(document.title).toBe(originalTitle);
  });

  it('updates the public page and persists the language selected in the shared navbar', async () => {
    act(() => root.render(
      <MemoryRouter initialEntries={['/architecture']}><LandingPage page="architecture" /></MemoryRouter>,
    ));
    const select = container.querySelector<HTMLSelectElement>('nav select[aria-label="Language"]')!;
    await act(async () => {
      select.value = 'fr';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(container.querySelector('main h2')?.textContent).toBe('Suivez la connexion');
    expect(document.documentElement.lang).toBe('fr');
    expect(localStorage.getItem('voxium_language')).toBe('fr');
  });

  it.each([
    { status: 200, payload: { success: true, data: { community_funding: false } } },
    { status: 200, payload: { success: true } },
    { status: 503, payload: { success: true, data: { community_funding: true } } },
  ])('hides supporter content unless the funding flag is enabled ($status)', async ({ status, payload }) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload), { status })));
    await act(async () => root.render(
      <MemoryRouter initialEntries={['/contributors']}><LandingPage page="contributors" /></MemoryRouter>,
    ));
    expect(container.querySelector('#supporters')).toBeNull();
    expect(container.querySelector('a[href="#supporters"]')).toBeNull();
    expect(container.querySelector('footer a[href="/contributors"]')?.textContent?.trim()).toBe('Contributors');
    expect(warn).toHaveBeenCalledTimes(status === 503 ? 1 : 0);
  });

  it('renders handles first, links to profiles, and falls back to initials on a failed local image', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      success: true,
      data: { community_funding: true },
    }))));
    await act(async () => root.render(
      <MemoryRouter initialEntries={['/contributors']}><LandingPage page="contributors" /></MemoryRouter>,
    ));
    expect(container.querySelector('nav a[aria-current="page"]')?.getAttribute('href')).toBe('/contributors');
    const credits = [...container.querySelectorAll('#project-contributors article')];
    expect(credits.map((entry) => entry.querySelector('h3')?.textContent)).toEqual(['@Aizen93', '@jdotc1', '@XRafik']);
    expect(credits.map((entry) => entry.querySelector('.lp-public-person-name')?.textContent))
      .toEqual(['Oussama Aouessar · Founder and maintainer', 'Jeff', undefined]);
    expect(credits.map((entry) => entry.querySelector('a')?.getAttribute('href')))
      .toEqual(['https://github.com/Aizen93', 'https://github.com/jdotc1', 'https://github.com/XRafik']);
    expect(credits.map((entry) => entry.querySelector('img')?.getAttribute('src')))
      .toEqual(['/contributor-avatars/aizen93.jpg', '/contributor-avatars/jdotc1.jpg', '/contributor-avatars/xrafik.png']);
    expect(container.querySelector('#supporters a')?.getAttribute('href')).toBe('https://github.com/sponsors/Aizen93');
    expect(container.querySelector('a[href="#supporters"]')).not.toBeNull();
    expect(container.querySelector('footer a[href="/contributors"]')?.textContent?.trim()).toBe('Contributors & supporters');
    const avatar = credits[0].querySelector('.lp-public-avatar')!;
    act(() => { avatar.querySelector('img')!.dispatchEvent(new Event('error')); });
    expect(avatar.querySelector('img')).toBeNull();
    expect(avatar.textContent).toBe('OA');
    expect(container.querySelector('#supporters ul')).toBeNull();
  });

  it('recognizes named and anonymous supporters and respects the funding switch', () => {
    const supporters = [
      { id: 'public', name: 'Public supporter', github: 'supporter' },
      { id: 'name-only', name: 'Name-only supporter' },
      { id: 'private', anonymous: true as const },
    ];
    act(() => root.render(<SupporterAcknowledgments showFunding supporters={supporters} />));
    expect([...container.querySelectorAll('#supporters li')].map((row) => row.textContent))
      .toEqual(['Public supporter ', 'Name-only supporter', 'Anonymous supporter']);
    expect(container.querySelector('#supporters a')?.getAttribute('href')).toBe('https://github.com/supporter');
    expect(container.querySelector('#supporters a[href*="/sponsors/"]')).not.toBeNull();
    act(() => root.render(<SupporterAcknowledgments showFunding={false} supporters={supporters} />));
    expect(container.querySelector('#supporters')).toBeNull();
    expect(container.textContent).not.toContain('Thank you for supporting Voxium');
    expect(container.textContent).not.toContain('Donations help cover');
  });
});
