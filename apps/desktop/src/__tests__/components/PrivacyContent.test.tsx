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
  it('shows the date of the last change (the audit against the code, 2026-10-24)', () => {
    expect(container.textContent).toContain('Last updated: October 24, 2026');
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
    // The rotation trace (lastRotatedAt / lastRotatedById on the webhook row,
    // migration 20261019090000_webhook_owner_decisions) names a member too
    expect(line).toContain('who last rotated their URL and when');
    // The execute route stores only the rendered message, never the body
    expect(line).toContain('the body of a request a webhook receives is not kept beyond the message it produced');
    // ...but the JSON access log keeps the ip, method, redacted path, status
    // and size of every delivery: the policy must not claim the whole request
    expect(line).not.toContain('the request a webhook receives is not kept');
  });

  it('says what survives an account deletion, after the catch-all "Everything else" item', () => {
    const items = retentionItems();
    const everythingElse = items.findIndex((text) => text.startsWith('Everything else'));
    const after = items.findIndex((text) => text.startsWith('After you delete your account'));
    expect(after).toBeGreaterThan(everythingElse);
    const line = items[after];
    // AuditLog.actor is onDelete: SetNull — the entries outlive the account
    expect(line).toContain('records of moderation and administrative actions, no longer linked to your account');
    // IpBan rows carry no user link
    expect(line).toContain('IP addresses on our block list, until the block is lifted');
    // Attachments of deleted messages are reclaimed by the orphan sweep, not inline
    expect(line).toContain('files you uploaded, until a daily clean-up removes them');
    expect(line).toContain('server logs and encrypted backups');
  });

  it('says reactions and the call notices of encrypted conversations are stored readable', () => {
    const text = (container.textContent ?? '').replace(/\s+/g, ' ');
    // MessageReaction.emoji is a plain column; dmVoiceHandler stores DM_SYSTEM_NOTICES as plaintext rows
    expect(text).toContain('Reactions (the emoji, who added it and to which message) are stored in readable form');
    expect(text).toContain('“call started” and “call ended” notices are stored in readable form');
  });

  it('keeps the webhook line inside the retention list, before the catch-all "Everything else" item', () => {
    const items = retentionItems();
    const webhook = items.findIndex((text) => text.startsWith('Incoming webhooks'));
    const everythingElse = items.findIndex((text) => text.startsWith('Everything else'));
    expect(webhook).toBeGreaterThanOrEqual(0);
    expect(everythingElse).toBeGreaterThan(webhook);
  });
});
