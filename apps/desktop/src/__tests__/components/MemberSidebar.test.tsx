import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactNode } from 'react';
import type { Channel, ServerMember, VoiceUser } from '@voxium/shared';
import type { PeopleState } from '../../stores/serverStore';

/**
 * The People panel is a PRESENCE view (CLAUDE.md "Server Membership"): on a
 * small server every member is loaded and the Offline section lists them; on
 * a big one the rows are the online slice, the Offline section is a count
 * and a way into the directory, and a slice cut at the cap says how many
 * more are online. The header count is the rows on a small server and the
 * server's figure on a big one.
 */

const t = (k: string, o?: Record<string, unknown>) => (o && 'count' in o ? `${k}:${o.count}` : k);
vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t }) };
});

const S = vi.hoisted(() => ({ requestServerSettings: vi.fn(), ensureMembers: vi.fn() }));
let members: ServerMember[] = [];
let channels: Channel[] = [];
let people: PeopleState = { full: true, truncated: false, onlineCount: 0, memberCount: 0, loaded: true };
let channelUsers = new Map<string, VoiceUser[]>();
vi.mock('../../stores/serverStore', () => {
  const state = () => ({ members, roles: [], channels, people, activeServerId: 'srv-1', ...S });
  const useServerStore = <T,>(sel?: (s: ReturnType<typeof state>) => T) => (sel ? sel(state()) : state());
  useServerStore.getState = state;
  return { useServerStore };
});
vi.mock('../../stores/voiceStore', () => {
  const state = () => ({ channelUsers });
  const useVoiceStore = <T,>(sel?: (s: ReturnType<typeof state>) => T) => (sel ? sel(state()) : state());
  useVoiceStore.getState = state;
  return { useVoiceStore };
});
let connection = 'connected';
vi.mock('../../services/socket', () => ({
  getConnectionStatus: () => connection,
  onConnectionStatusChange: () => () => {},
}));
vi.mock('../../stores/authStore', () => {
  const state = () => ({ user: { id: 'me', username: 'me', displayName: 'ME' } });
  const useAuthStore = <T,>(sel?: (s: ReturnType<typeof state>) => T) => (sel ? sel(state()) : state());
  useAuthStore.getState = state;
  return { useAuthStore };
});
vi.mock('../../components/common/UserHoverTarget', () => ({
  UserHoverTarget: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
vi.mock('../../components/server/MemberContextMenu', () => ({ MemberContextMenu: () => null }));

import { MemberSidebar } from '../../components/server/MemberSidebar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const row = (id: string, status: string, role: ServerMember['role'] = 'member'): ServerMember =>
  ({ userId: id, serverId: 'srv-1', role, nickname: null, joinedAt: '2026-10-01T00:00:00.000Z', roles: [],
    user: { id, username: id, displayName: id.toUpperCase(), avatarUrl: null, status } } as unknown as ServerMember);
const vu = (id: string): VoiceUser => ({ id, username: id, displayName: id, avatarUrl: null, selfMute: false, selfDeaf: false, serverMuted: false, serverDeafened: false, speaking: false });

let container: HTMLDivElement;
let root: Root;
const q = (sel: string) => container.querySelector(sel) as HTMLElement | null;
const names = () => Array.from(container.querySelectorAll('button span.truncate')).map((el) => el.textContent);
const labels = () => Array.from(container.querySelectorAll('h3')).map((el) => el.textContent);

async function render() {
  await act(async () => { root.render(<MemberSidebar />); });
}

beforeEach(() => {
  vi.clearAllMocks();
  connection = 'connected';
  members = [row('me', 'online', 'owner'), row('bob', 'online'), row('carol', 'idle'), row('dave', 'offline')];
  channels = [];
  channelUsers = new Map();
  people = { full: true, truncated: false, onlineCount: 3, memberCount: 4, loaded: true };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('MemberSidebar — a small server (everyone loaded)', () => {
  it('lists the offline members in their own section, counts the present rows, and offers no directory link', async () => {
    await render();
    expect(names()).toEqual(['BOB', 'ME', 'CAROL', 'DAVE']);
    expect(labels()).toEqual(['people.active · 2', 'people.away · 1', 'people.offline · 1']);
    expect(q('[data-testid="people-online-count"]')!.textContent).toBe('3');
    expect(q('[data-testid="people-browse-all"]')).toBeNull();
    expect(q('[data-testid="people-more-online"]')).toBeNull();
  });

  it('the rows are the truth for the count, whatever the server said', async () => {
    people = { ...people, onlineCount: 99 };
    await render();
    expect(q('[data-testid="people-online-count"]')!.textContent).toBe('3');
  });

  it('our own row reads online while the socket is up, even when the slice still carries it as offline (nobody echoes our presence to us)', async () => {
    members = [row('me', 'offline', 'owner'), row('dave', 'offline')];
    people = { ...people, onlineCount: 0, memberCount: 2 };
    await render();
    expect(labels()).toEqual(['people.active · 1', 'people.offline · 1']);
    expect(q('[data-testid="people-online-count"]')!.textContent).toBe('1');
  });

  it('with the socket down our own row is what the slice says', async () => {
    connection = 'disconnected';
    members = [row('me', 'offline', 'owner'), row('dave', 'offline')];
    people = { ...people, onlineCount: 0, memberCount: 2 };
    await render();
    expect(labels()).toEqual(['people.offline · 2']);
    expect(q('[data-testid="people-online-count"]')!.textContent).toBe('0');
  });
});

describe('MemberSidebar — a big server (the online slice)', () => {
  beforeEach(() => {
    people = { full: false, truncated: false, onlineCount: 640, memberCount: 12_000, loaded: true };
  });

  it('shows no offline row; the Offline section is the count of the members not here and a way into the directory', async () => {
    await render();
    expect(names()).toEqual(['BOB', 'ME', 'CAROL']);
    expect(labels()).toEqual(['people.active · 2', 'people.away · 1', 'people.offline · 11360']);
    expect(q('[data-testid="people-online-count"]')!.textContent).toBe('640');
    const browse = q('[data-testid="people-browse-all"]')!;
    expect(browse.textContent).toBe('people.browseAll');
    await act(async () => { browse.click(); });
    expect(S.requestServerSettings).toHaveBeenCalledWith('srv-1', 'members');
  });

  it('a slice cut at the cap says how many more are online; a complete slice does not', async () => {
    people = { ...people, truncated: true };
    await render();
    // 640 online, 3 on screen
    expect(q('[data-testid="people-more-online"]')!.textContent).toBe('people.moreOnline:637');
    people = { ...people, truncated: false };
    await render();
    expect(q('[data-testid="people-more-online"]')).toBeNull();
  });

  it('the count never drops below the rows on screen (events can run ahead of the figure)', async () => {
    people = { ...people, onlineCount: 1 };
    await render();
    expect(q('[data-testid="people-online-count"]')!.textContent).toBe('3');
  });

  it('before the slice loaded there is neither an Offline section nor a directory link', async () => {
    people = { full: true, truncated: false, onlineCount: 0, memberCount: 0, loaded: false };
    members = [];
    await render();
    expect(q('[data-testid="people-browse-all"]')).toBeNull();
    expect(labels()).toEqual([]);
  });
});

describe('MemberSidebar — voice participants', () => {
  it('a participant with no row is asked for (batched), and listed under the channel once it lands', async () => {
    channels = [{ id: 'vc-1', name: 'Lounge', type: 'voice', serverId: 'srv-1' } as Channel];
    channelUsers = new Map([['vc-1', [vu('bob'), vu('zed')]]]);
    await render();
    expect(S.ensureMembers).toHaveBeenCalledWith(['zed']);
    expect(labels()[0]).toBe('people.inVoice · Lounge');
    expect(names()[0]).toBe('BOB');
    members = [...members, row('zed', 'online')];
    await render();
    expect(names().slice(0, 2)).toEqual(['BOB', 'ZED']);
  });
});
