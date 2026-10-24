import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * The dropdown offers `@everyone` only when the composer says the author may
 * ping the channel (MENTION_EVERYONE). Selecting it inserts the literal token:
 * the server decides on send whether it pings, and renders it as text if not.
 */

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t: (k: string, o?: Record<string, unknown>) => (o?.query !== undefined ? `${k}:${o.query}` : k) }) };
});
vi.mock('../../stores/serverStore', () => ({
  useServerStore: (selector: (s: { activeServerId: string }) => unknown) => selector({ activeServerId: 'srv-1' }),
}));
const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../services/api', () => ({ api }));
vi.mock('../../components/common/Avatar', () => ({ Avatar: () => null }));

import { MentionAutocomplete, handleMentionKeyDown, everyoneMatches, type MentionCandidate } from '../../components/chat/MentionAutocomplete';

let root: Root;
let container: HTMLDivElement;

function render(ui: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(ui));
  return container;
}

beforeEach(() => {
  api.get.mockReset();
  api.get.mockResolvedValue({ data: { data: [] } });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const noop = () => {};

describe('MentionAutocomplete — the @everyone row', () => {
  it('is offered for a matching query when the author may ping the channel, and reports it first in the keyboard list', () => {
    let results: MentionCandidate[] = [];
    const el = render(
      <MentionAutocomplete text="@ev" cursorPos={3} canMentionEveryone onSelect={noop} onSelectEveryone={noop} onClose={noop} onResultsChange={(r) => { results = r; }} />,
    );
    expect(el.querySelector('[data-testid="mention-everyone-option"]')).not.toBeNull();
    expect(el.textContent).toContain('chat.mentionEveryone.label');
    expect(el.textContent).toContain('chat.mentionAutocomplete.header:ev');
    expect(results[0]).toEqual({ kind: 'everyone' });
  });

  it('is not offered without the permission, nor for a query that is not a prefix of "everyone"', () => {
    const el = render(
      <MentionAutocomplete text="@ev" cursorPos={3} canMentionEveryone={false} onSelect={noop} onClose={noop} onResultsChange={noop} />,
    );
    expect(el.querySelector('[data-testid="mention-everyone-option"]')).toBeNull();

    act(() => root.unmount());
    container.remove();
    const el2 = render(
      <MentionAutocomplete text="@bob" cursorPos={4} canMentionEveryone onSelect={noop} onClose={noop} onResultsChange={noop} />,
    );
    expect(el2.querySelector('[data-testid="mention-everyone-option"]')).toBeNull();
  });

  it('selecting it hands the composer the span of the @query, so it can insert the literal token', () => {
    const onSelectEveryone = vi.fn();
    const onSelect = vi.fn();
    const el = render(
      <MentionAutocomplete text="hi @eve" cursorPos={7} canMentionEveryone onSelect={onSelect} onSelectEveryone={onSelectEveryone} onClose={noop} onResultsChange={noop} />,
    );
    act(() => {
      el.querySelector('[data-testid="mention-everyone-option"]')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(onSelectEveryone).toHaveBeenCalledWith(3, 7);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('everyoneMatches: any prefix of "everyone", case-insensitively, including the empty query', () => {
    for (const q of ['', 'e', 'Ev', 'everyone']) expect(everyoneMatches(q)).toBe(true);
    for (const q of ['everyone2', 'bob', 'x']) expect(everyoneMatches(q)).toBe(false);
  });

  it('handleMentionKeyDown selects whichever candidate is highlighted, the @everyone row included', () => {
    const onSelect = vi.fn();
    const candidates: MentionCandidate[] = [{ kind: 'everyone' }];
    const preventDefault = vi.fn();
    const consumed = handleMentionKeyDown({ key: 'Enter', preventDefault } as unknown as React.KeyboardEvent, candidates, 0, noop, onSelect);
    expect(consumed).toBe(true);
    expect(onSelect).toHaveBeenCalledWith({ kind: 'everyone' });
    expect(preventDefault).toHaveBeenCalled();
  });
});
