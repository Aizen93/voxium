import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, click, getByRole, queryByRole, bodyText, choose, type, type Mounted } from '../helpers/dom';

/**
 * The announcement composer: a labelled "Link to a document" select (None by
 * default) whose value is sent on create, and a list column that shows which
 * document an announcement links to.
 */

const store = vi.hoisted(() => ({
  announcements: [] as Array<Record<string, unknown>>,
  announcementsTotal: 0,
  announcementsPage: 1,
  announcementsFilter: 'all',
  fetchAnnouncements: vi.fn(),
  setAnnouncementsFilter: vi.fn(),
  createAnnouncement: vi.fn(),
  publishAnnouncement: vi.fn(),
  deleteAnnouncement: vi.fn(),
  servers: [] as unknown[],
  fetchServers: vi.fn(),
}));
vi.mock('../../stores/adminStore', () => ({ useAdminStore: Object.assign(() => store, { getState: () => store }) }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('../../stores/toastStore', () => ({ toast }));

import { AdminAnnouncements } from '../../components/AdminAnnouncements';

function announcement(id: string, legalDoc?: string | null) {
  return {
    id, title: `Title ${id}`, content: 'Body', type: 'info', scope: 'global', serverIds: [],
    createdById: 'u1', createdByUsername: 'admin', publishedAt: null, expiresAt: null,
    createdAt: new Date(0).toISOString(), ...(legalDoc === undefined ? {} : { legalDoc }),
  };
}

let view: Mounted;

async function openComposer() {
  await view.render(<AdminAnnouncements />);
  await click(getByRole('button', 'Create Announcement'));
}

async function fillAndSave() {
  await type(getByRole('textbox', 'Announcement title...'), 'Privacy change');
  await type(getByRole('textbox', 'Announcement content...'), 'We are changing it.');
  await click(getByRole('button', 'Save Draft'));
}

beforeEach(() => {
  vi.clearAllMocks();
  store.announcements = [];
  store.fetchAnnouncements.mockResolvedValue(undefined);
  store.createAnnouncement.mockResolvedValue(undefined);
  view = mount();
});
afterEach(() => view.unmount());

describe('AdminAnnouncements: the document select', () => {
  it('is labelled, offers None first and the three documents by their desktop names', async () => {
    await openComposer();
    const select = getByRole('combobox', 'Link to a document') as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
      'None', 'Privacy Policy', 'Terms of Service', 'Cookie Policy',
    ]);
    expect(select.value).toBe('');
  });

  it('sends the chosen document on create', async () => {
    await openComposer();
    await choose(getByRole('combobox', 'Link to a document'), 'privacy');
    await fillAndSave();
    expect(store.createAnnouncement).toHaveBeenCalledTimes(1);
    expect(store.createAnnouncement.mock.calls[0][0]).toMatchObject({ title: 'Privacy change', legalDoc: 'privacy' });
  });

  it.each([['terms'], ['cookies']])('sends %s', async (doc) => {
    await openComposer();
    await choose(getByRole('combobox', 'Link to a document'), doc);
    await fillAndSave();
    expect(store.createAnnouncement.mock.calls[0][0].legalDoc).toBe(doc);
  });

  it('None sends no document', async () => {
    await openComposer();
    await fillAndSave();
    expect(store.createAnnouncement.mock.calls[0][0].legalDoc).toBeUndefined();
  });

  it('choosing a document and going back to None sends no document', async () => {
    await openComposer();
    const select = getByRole('combobox', 'Link to a document');
    await choose(select, 'terms');
    await choose(select, '');
    await fillAndSave();
    expect(store.createAnnouncement.mock.calls[0][0].legalDoc).toBeUndefined();
  });

  it('closes the composer after a save', async () => {
    await openComposer();
    await fillAndSave();
    expect(queryByRole('combobox', 'Link to a document')).toBeNull();
  });
});

describe('AdminAnnouncements: the list', () => {
  it('shows which document an announcement links to, and None for the others', async () => {
    store.announcements = [announcement('a1', 'privacy'), announcement('a2', 'cookies'), announcement('a3', null), announcement('a4')];
    store.announcementsTotal = 4;
    await view.render(<AdminAnnouncements />);
    const text = bodyText();
    expect(text).toContain('Document');
    expect(text).toContain('Privacy Policy');
    expect(text).toContain('Cookie Policy');
    const rows = Array.from(document.body.querySelectorAll('tbody tr'));
    expect(rows).toHaveLength(4);
    expect(rows[2].textContent).toContain('None');
    expect(rows[3].textContent).toContain('None');
  });
});
