import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PrivacyContent } from '../../components/legal/PrivacyContent';

/**
 * The Privacy Policy is part of what a user consents to at signup, so its
 * factual claims must follow the code (components/legal/PrivacyContent.tsx:
 * "Change the code, change this"). These pin the lines that describe a
 * specific mechanism, so a change to the mechanism has to touch them.
 */

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => { root.render(<PrivacyContent />); });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** The retention list items (section 6), as their rendered text. */
function retentionItems(): string[] {
  const heading = Array.from(container.querySelectorAll('h2')).find((h) => h.textContent?.includes('Retention'));
  expect(heading).toBeTruthy();
  const list = heading!.parentElement!.querySelector('ul');
  expect(list).toBeTruthy();
  return Array.from(list!.querySelectorAll('li')).map((li) => (li.textContent ?? '').replace(/\s+/g, ' ').trim());
}

describe('PrivacyContent', () => {
  it('shows the date of the last change (the incoming-webhooks line, 2026-10-18)', () => {
    expect(container.textContent).toContain('Last updated: October 18, 2026');
  });

  it('says what an incoming webhook stores and that the body of an inbound request is not kept', () => {
    const line = retentionItems().find((text) => text.startsWith('Incoming webhooks'));
    expect(line).toBeDefined();
    // What the webhooks table holds besides its credential: name, channel,
    // creator and last-used time (routes/webhooks.ts, the list shape)
    expect(line).toContain('their name');
    expect(line).toContain('the channel they post to');
    expect(line).toContain('who created them');
    expect(line).toContain('when they were last used');
    // The execute route stores only the rendered message, never the body
    expect(line).toContain('the body of a request a webhook receives is not kept beyond the message it produced');
    // ...but the JSON access log keeps the ip, method, redacted path, status
    // and size of every delivery: the policy must not claim the whole request
    expect(line).not.toContain('the request a webhook receives is not kept');
  });

  it('keeps the webhook line inside the retention list, before the catch-all "Everything else" item', () => {
    const items = retentionItems();
    const webhook = items.findIndex((text) => text.startsWith('Incoming webhooks'));
    const everythingElse = items.findIndex((text) => text.startsWith('Everything else'));
    expect(webhook).toBeGreaterThanOrEqual(0);
    expect(everythingElse).toBeGreaterThan(webhook);
  });
});
