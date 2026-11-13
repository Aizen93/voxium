import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
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
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('public landing pages', () => {
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
  ])('keeps the sponsor link hidden without an enabled flag in a successful response ($status)', async ({ status, payload }) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload), { status })));
    await act(async () => root.render(
      <MemoryRouter initialEntries={['/contributors']}><LandingPage page="contributors" /></MemoryRouter>,
    ));
    expect(container.querySelector('#supporters a[href*="/sponsors/"]')).toBeNull();
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
    const avatar = credits[0].querySelector('.lp-public-avatar')!;
    act(() => { avatar.querySelector('img')!.dispatchEvent(new Event('error')); });
    expect(avatar.querySelector('img')).toBeNull();
    expect(avatar.textContent).toBe('OA');
    expect(container.querySelector('#supporters ul')).toBeNull();
  });

  it('recognizes named and anonymous supporters and respects the funding switch', () => {
    act(() => root.render(<SupporterAcknowledgments showFunding={false} supporters={[
      { id: 'public', name: 'Public supporter', github: 'supporter' },
      { id: 'name-only', name: 'Name-only supporter' },
      { id: 'private', anonymous: true },
    ]} />));
    expect([...container.querySelectorAll('#supporters li')].map((row) => row.textContent))
      .toEqual(['Public supporter ', 'Name-only supporter', 'Anonymous supporter']);
    expect(container.querySelector('#supporters a')?.getAttribute('href')).toBe('https://github.com/supporter');
    expect(container.querySelector('#supporters a[href*="/sponsors/"]')).toBeNull();
  });
});
