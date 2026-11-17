import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// External links in the desktop app open in the system browser or the mail
// client from one click handler (utils/externalLinks.ts), through the opener
// plugin; in a browser they open a new tab and the handler is not installed.

const opener = vi.hoisted(() => ({ openUrl: vi.fn(async (_url: string) => {}), loads: 0 }));
vi.mock('@tauri-apps/plugin-opener', () => {
  opener.loads += 1;
  return { openUrl: opener.openUrl };
});

import { createElement } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import { EXTERNAL_LINK_PROTOCOLS, externalLinkUrl, installExternalLinkHandler } from '../../utils/externalLinks';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DESKTOP = resolve(__dirname, '../../..');

function anchor(attributes: Record<string, string>, text = 'link'): HTMLAnchorElement {
  const a = document.createElement('a');
  for (const [name, value] of Object.entries(attributes)) a.setAttribute(name, value);
  a.textContent = text;
  document.body.appendChild(a);
  return a;
}

/** Click `target` and report whether the click was taken from the webview. */
function click(target: Element, init: MouseEventInit = {}): boolean {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

/** For each click, whether it reached the window still the webview's (not prevented); the window then stops it, jsdom cannot navigate. */
function recordWhatReachesTheWindow(): { reached: boolean[]; stop: () => void } {
  const reached: boolean[] = [];
  const record = (event: Event) => {
    reached.push(!event.defaultPrevented);
    event.preventDefault();
  };
  window.addEventListener('click', record);
  return { reached, stop: () => window.removeEventListener('click', record) };
}

let uninstall: () => void = () => {};
let error: ReturnType<typeof vi.spyOn>;
/** jsdom cannot navigate: whatever reaches the window is stopped there, after the handler under test. */
const stopNavigation = (event: Event) => event.preventDefault();

beforeEach(() => {
  opener.openUrl.mockClear();
  opener.openUrl.mockImplementation(async () => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  uninstall();
  uninstall = () => {};
  window.removeEventListener('click', stopNavigation);
  document.body.innerHTML = '';
  error.mockRestore();
});

describe('externalLinkUrl', () => {
  it('takes target="_blank" links to http, https and mailto', () => {
    expect(externalLinkUrl(anchor({ href: 'https://example.org/a?b=1#c', target: '_blank' }))).toBe('https://example.org/a?b=1#c');
    expect(externalLinkUrl(anchor({ href: 'http://example.org', target: '_blank' }))).toBe('http://example.org/');
    expect(externalLinkUrl(anchor({ href: 'mailto:privacy@example.org', target: '_blank' }))).toBe('mailto:privacy@example.org');
    expect(externalLinkUrl(anchor({ href: ' HTTPS://Example.org/x ', target: '_BLANK' }))).toBe('https://example.org/x');
  });

  it('opens a scheme-relative link over https, like a browser on an https page', () => {
    expect(externalLinkUrl(anchor({ href: '//example.org/a', target: '_blank' }))).toBe('https://example.org/a');
    expect(externalLinkUrl(anchor({ href: '//Example.org:8443/a?b#c', target: '_blank' }))).toBe('https://example.org:8443/a?b#c');
    expect(externalLinkUrl(anchor({ href: '//example.org/a', target: '_self' }))).toBeNull();
  });

  it('leaves every other scheme, a relative href and any other target alone', () => {
    for (const href of [
      'javascript:alert(1)',
      ' javascript:alert(1)',
      'file:///C:/Windows/System32/calc.exe',
      'tel:+33123456789',
      'data:text/html,<b>x</b>',
      'blob:https://example.org/1',
      'ftp://example.org/x',
      'ipc://localhost/x',
      '/settings',
      'settings',
      '#top',
      '///evil.example/x',
      '//',
      '/\\evil.example/x',
      '//\\evil.example/x',
      '',
    ]) {
      expect(externalLinkUrl(anchor({ href, target: '_blank' })), href).toBeNull();
    }
    expect(externalLinkUrl(anchor({ target: '_blank' }))).toBeNull();
    for (const target of ['_self', '_top', '_parent', 'other', '']) {
      expect(externalLinkUrl(anchor({ href: 'https://example.org', target })), target).toBeNull();
    }
    expect(externalLinkUrl(anchor({ href: 'https://example.org' }))).toBeNull();
  });
});

describe('the click handler', () => {
  function install(open = opener.openUrl) {
    uninstall = installExternalLinkHandler({ isTauri: true, open });
    window.addEventListener('click', stopNavigation);
  }

  it('opens http, https and mailto links through the system and keeps them from the webview', () => {
    install();
    for (const href of ['https://example.org/docs', 'http://example.org/', 'mailto:support@example.org', '//example.org/a']) {
      expect(click(anchor({ href, target: '_blank', rel: 'noopener noreferrer' })), href).toBe(true);
    }
    expect(opener.openUrl.mock.calls.map(([url]) => url)).toEqual([
      'https://example.org/docs',
      'http://example.org/',
      'mailto:support@example.org',
      'https://example.org/a',
    ]);
  });

  it('a click on something inside the link counts as a click on the link', () => {
    install();
    const a = anchor({ href: 'https://example.org', target: '_blank' }, '');
    const inner = document.createElement('strong');
    inner.textContent = 'bold';
    a.appendChild(inner);
    expect(click(inner)).toBe(true);
    expect(opener.openUrl).toHaveBeenCalledWith('https://example.org/');
  });

  it('leaves javascript:, file:, tel:, a relative href and another target to the webview', () => {
    install();
    const leftAlone = [
      anchor({ href: 'javascript:void(0)', target: '_blank' }),
      anchor({ href: 'file:///etc/passwd', target: '_blank' }),
      anchor({ href: 'tel:+33123456789', target: '_blank' }),
      anchor({ href: '/channels/1', target: '_blank' }),
      anchor({ href: '///channels/1', target: '_blank' }),
      anchor({ href: '//', target: '_blank' }),
      anchor({ href: 'channels/1', target: '_blank' }),
      anchor({ href: 'https://example.org', target: '_self' }),
      anchor({ href: 'https://example.org' }),
    ];
    window.removeEventListener('click', stopNavigation);
    const window_ = recordWhatReachesTheWindow();
    for (const a of leftAlone) click(a);
    window_.stop();
    // every one reached the window as the webview's own click
    expect(window_.reached).toEqual(leftAlone.map(() => true));
    expect(opener.openUrl).not.toHaveBeenCalled();
  });

  it('leaves a click taken by a listener ahead of it, and a click of another button', () => {
    install();
    const takeAll = (event: Event) => event.preventDefault();
    window.addEventListener('click', takeAll, { capture: true });
    click(anchor({ href: 'https://example.org', target: '_blank' }));
    window.removeEventListener('click', takeAll, { capture: true });
    click(anchor({ href: 'https://example.org', target: '_blank' }), { button: 1 });
    expect(opener.openUrl).not.toHaveBeenCalled();
  });

  it('still opens a link whose ancestor stops the click from propagating', () => {
    install();
    const guard = document.createElement('div');
    guard.addEventListener('click', (event) => event.stopPropagation());
    document.body.appendChild(guard);
    const a = anchor({ href: 'mailto:privacy@example.org', target: '_blank' });
    guard.appendChild(a);
    expect(click(a)).toBe(true);
    expect(opener.openUrl).toHaveBeenCalledWith('mailto:privacy@example.org');
  });

  it("still opens a link in a React portal whose content stops the click's propagation", async () => {
    install();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        createPortal(
          createElement(
            'div',
            { onClick: (event: { stopPropagation(): void }) => event.stopPropagation() },
            createElement('a', { href: 'https://example.org/policy', target: '_blank', rel: 'noopener noreferrer' }, 'policy')
          ),
          document.body
        )
      );
    });
    const a = document.querySelector('a[href="https://example.org/policy"]')!;
    expect(click(a)).toBe(true);
    expect(opener.openUrl).toHaveBeenCalledWith('https://example.org/policy');
    act(() => root.unmount());
  });

  it('logs a link the system could not open as a fixed line, nothing of what the failure carried', async () => {
    // a Tauri command rejects with a string; on macOS and Linux it carries the launcher's arguments
    const invite = 'https://chat.example.org/invite/AbCdEf123';
    install(vi.fn(async () => {
      throw `Failed to run xdg-open with args ["${invite}"]: No such file or directory`;
    }));
    expect(click(anchor({ href: invite, target: '_blank' }))).toBe(true);
    await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(1));
    expect(error).toHaveBeenCalledWith('[Links] Could not open an external link');
    expect(JSON.stringify(error.mock.calls)).not.toContain('example.org');

    error.mockClear();
    uninstall();
    install(vi.fn(async () => {
      throw new Error('mailto:someone@example.org: no handler for this scheme');
    }));
    click(anchor({ href: 'mailto:someone@example.org', target: '_blank' }));
    await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(1));
    expect(error.mock.calls[0]).toEqual(['[Links] Could not open an external link']);
  });

  it('is installed once however often it is asked, and removed by what it returns', () => {
    install();
    expect(installExternalLinkHandler({ isTauri: true, open: opener.openUrl })).toBe(uninstall);
    click(anchor({ href: 'https://example.org', target: '_blank' }));
    expect(opener.openUrl).toHaveBeenCalledTimes(1);

    uninstall();
    click(anchor({ href: 'https://example.org/2', target: '_blank' }));
    expect(opener.openUrl).toHaveBeenCalledTimes(1);
  });

  it('opens through the opener plugin, loaded on the first external click', async () => {
    expect(opener.loads).toBe(0);
    uninstall = installExternalLinkHandler({ isTauri: true });
    window.addEventListener('click', stopNavigation);
    expect(opener.loads).toBe(0);
    expect(click(anchor({ href: 'https://example.org/first', target: '_blank' }))).toBe(true);
    await vi.waitFor(() => expect(opener.openUrl).toHaveBeenCalledWith('https://example.org/first'));
    click(anchor({ href: 'https://example.org/second', target: '_blank' }));
    await vi.waitFor(() => expect(opener.openUrl).toHaveBeenCalledWith('https://example.org/second'));
    expect(opener.loads).toBe(1);
  });
});

describe('in a browser', () => {
  it('installs nothing: a link opens in a new tab as the browser decides', () => {
    expect('__TAURI_INTERNALS__' in window).toBe(false);
    const window_ = recordWhatReachesTheWindow();
    uninstall = installExternalLinkHandler({ open: opener.openUrl });
    click(anchor({ href: 'https://example.org', target: '_blank' }));
    uninstall = installExternalLinkHandler({ isTauri: false, open: opener.openUrl });
    click(anchor({ href: 'mailto:a@example.org', target: '_blank' }));
    window_.stop();

    expect(window_.reached).toEqual([true, true]);
    expect(opener.openUrl).not.toHaveBeenCalled();
  });

  it('the app installs it at start, before rendering, and the scheme list is the capability scope', () => {
    const main = readFileSync(join(DESKTOP, 'src', 'main.tsx'), 'utf8');
    const install = main.indexOf('installExternalLinkHandler();');
    expect(install).toBeGreaterThan(-1);
    expect(install).toBeLessThan(main.indexOf('ReactDOM.createRoot('));
    expect(main.match(/installExternalLinkHandler\(/g)).toHaveLength(1);

    const capability = JSON.parse(readFileSync(join(DESKTOP, 'src-tauri', 'capabilities', 'default.json'), 'utf8')) as {
      permissions: Array<string | { identifier: string; allow?: Array<{ url: string }> }>;
    };
    const scope = capability.permissions.find((p) => typeof p !== 'string' && p.identifier === 'opener:allow-open-url');
    const schemes = (scope as { allow: Array<{ url: string }> }).allow.map(({ url }) => `${url.split(':')[0]}:`);
    expect(schemes.sort()).toEqual([...EXTERNAL_LINK_PROTOCOLS].sort());
  });
});
