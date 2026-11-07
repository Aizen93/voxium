import { describe, it, expect, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MessageContent } from '../../components/chat/MessageContent';

/**
 * `@everyone` renders as a mention ONLY when the server flagged the message
 * (`mentionsEveryone`: the author held MENTION_EVERYONE in the channel). The
 * bare text in an unflagged message stays text — rendering it as a ping
 * would claim a permission the author did not have.
 */

let root: Root;
let container: HTMLDivElement;

function render(ui: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(ui));
  return container;
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const alice = { id: 'u-alice', username: 'alice', displayName: 'Alice', avatarUrl: null };

describe('MessageContent — @everyone', () => {
  it('renders the token as a mention badge when the server flagged the message, keeping the text around it', () => {
    const el = render(<MessageContent content="hey @everyone, standup in 5" mentionsEveryone />);
    const badge = el.querySelector('[data-testid="mention-everyone"]');
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toBe('@everyone');
    // The text around it survives (markdown trims a paragraph's outer
    // whitespace, as it does around user mentions — the badge carries padding)
    expect(el.textContent).toMatch(/^hey\s*@everyone\s*, standup in 5$/);
    expect(el.querySelectorAll('[data-testid="mention-everyone"]')).toHaveLength(1);
  });

  it('renders the bare text when the server did not flag it (the author could not ping the channel)', () => {
    const el = render(<MessageContent content="hey @everyone, standup in 5" />);
    expect(el.querySelector('[data-testid="mention-everyone"]')).toBeNull();
    expect(el.textContent).toBe('hey @everyone, standup in 5');
  });

  it('renders at the start of the message and next to a user mention', () => {
    const el = render(<MessageContent content="@everyone and @[u-alice] too" mentions={[alice]} mentionsEveryone />);
    expect(el.querySelector('[data-testid="mention-everyone"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="mention-badge"]')!.textContent).toBe('@Alice');
    expect(el.textContent).toMatch(/^@everyone\s*and\s*@Alice\s*too$/);
  });

  it('does not take a longer word or a doubled @ for the token, even when flagged', () => {
    const el = render(<MessageContent content="@everyone2 @@everyone @everyone-else" mentionsEveryone />);
    expect(el.querySelector('[data-testid="mention-everyone"]')).toBeNull();
    expect(el.textContent).toBe('@everyone2 @@everyone @everyone-else');
  });
});
