import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * The rate-limit table: one row per rule with its key-type badge (IP, User,
 * Webhook) and, behind the help icon, the rule's description.
 */

type Rule = {
  name: string;
  label: string;
  keyType: 'ip' | 'userId' | 'account' | 'webhook';
  keyPrefix: string;
  points: number;
  duration: number;
  blockDuration: number;
  isCustom: boolean;
};

const store = vi.hoisted(() => ({
  rateLimits: [] as Rule[],
  fetchRateLimits: vi.fn(),
  updateRateLimit: vi.fn(),
  resetRateLimit: vi.fn(),
  clearUserRateLimits: vi.fn(),
}));
vi.mock('../../stores/adminStore', () => ({ useAdminStore: Object.assign(() => store, { getState: () => store }) }));

import { AdminRateLimits } from '../../components/AdminRateLimits';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function rule(name: string, keyType: Rule['keyType'], label: string): Rule {
  return { name, label, keyType, keyPrefix: `rl:${name}`, points: 30, duration: 60, blockDuration: 0, isCustom: false };
}

// The four webhook rules exactly as the server registers them
// (middleware/rateLimiter.ts): the per-webhook one is keyed on the webhook id
const WEBHOOK_RULES: Rule[] = [
  rule('webhookExecute', 'webhook', 'Webhook Execute (per webhook)'),
  rule('webhookExecuteIp', 'ip', 'Webhook Execute (per IP)'),
  rule('webhookManage', 'userId', 'Webhook Manage'),
  rule('webhookRead', 'userId', 'Webhook Read'),
];

const WEBHOOK_DESCRIPTIONS: Record<string, string> = {
  webhookExecute: 'Deliveries accepted per webhook per minute, charged only after the token matched.',
  webhookExecuteIp: "Webhook deliveries per client address per minute; generous because GitHub's deliveries share a few egress addresses.",
  webhookManage: 'Webhook create, edit, rotate and delete per user per hour.',
  webhookRead: 'Webhook list reads per user per minute.',
};

let container: HTMLDivElement;
let root: Root;

/** The table row whose rule-name caption is exactly `name`. */
function rowFor(name: string): HTMLTableRowElement {
  const caption = Array.from(document.body.querySelectorAll('tbody td span'))
    .find((el) => el.textContent === name);
  expect(caption, `row for ${name}`).toBeTruthy();
  return caption!.closest('tr') as HTMLTableRowElement;
}

/** The key-type badge: the only span of the row's second cell. */
function badgeOf(name: string): string {
  return rowFor(name).querySelectorAll('td')[1].textContent?.trim() ?? '';
}

/** Hovers the rule's help icon and answers the tooltip text, if any. */
async function hoverDescription(name: string): Promise<string | null> {
  const tip = rowFor(name).querySelector('td .cursor-help') as HTMLElement | null;
  if (!tip) return null;
  await act(async () => {
    tip.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }));
  });
  // The tooltip is portaled to document.body, outside the table
  const portaled = Array.from(document.body.children).filter((el) => el !== container);
  const text = portaled.map((el) => el.textContent ?? '').join('');
  await act(async () => {
    tip.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
  });
  return text;
}

async function render() {
  await act(async () => { root.render(<AdminRateLimits />); });
}

beforeEach(() => {
  vi.clearAllMocks();
  store.rateLimits = [rule('login', 'ip', 'Login'), rule('loginAccount', 'account', 'Login (failures per account)'), rule('messageSend', 'userId', 'Message Send'), ...WEBHOOK_RULES];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('AdminRateLimits — key-type badge', () => {
  it("renders 'Webhook' for keyType 'webhook', 'IP' for 'ip', 'Account' for 'account' and 'User' for 'userId'", async () => {
    await render();
    expect(store.fetchRateLimits).toHaveBeenCalledTimes(1);
    expect(badgeOf('webhookExecute')).toBe('Webhook');
    expect(badgeOf('webhookExecuteIp')).toBe('IP');
    expect(badgeOf('login')).toBe('IP');
    expect(badgeOf('loginAccount')).toBe('Account');
    expect(badgeOf('webhookManage')).toBe('User');
    expect(badgeOf('messageSend')).toBe('User');
  });
});

describe('AdminRateLimits — rule descriptions', () => {
  it.each(Object.keys(WEBHOOK_DESCRIPTIONS))('%s shows its description behind the help icon', async (name) => {
    await render();
    expect(await hoverDescription(name)).toBe(WEBHOOK_DESCRIPTIONS[name]);
  });

  it('a rule without a description renders no help icon', async () => {
    store.rateLimits = [rule('someFutureRule', 'userId', 'Some Future Rule')];
    await render();
    expect(await hoverDescription('someFutureRule')).toBeNull();
  });

  // What each bucket really charges (middleware/rateLimiter.ts and the routes
  // that mount it): the old texts said "login attempts" for a failures-only
  // bucket, "avatars, server icons" for a limiter attachments share, a
  // stats/health limiter that /health never had, and a "catch-all" for what
  // is the anonymous half of a per-IP / per-user pair.
  const CORRECTED: Array<[name: string, keyType: Rule['keyType'], mustSay: RegExp, mustNotSay?: RegExp]> = [
    ['login', 'ip', /failed sign-in attempts per ip.*successful sign-in is not counted/i],
    ['upload', 'userId', /message attachments/i],
    ['friendRequest', 'userId', /sending, accepting, declining and cancelling friend requests and removing friends/i],
    ['stats', 'ip', /public stats endpoint/i, /health/i],
    ['support', 'userId', /opening support tickets and sending ticket messages/i],
    // Webhook deliveries are mounted outside /api/v1 (app.ts), so neither general bucket charges them
    ['general', 'ip', /per-ip budget for requests without a valid sign-in.*every route under \/api\/v1 except webhook deliveries/i, /catch-all|every api route/i],
    ['generalUser', 'userId', /per-user budget for signed-in requests.*every route under \/api\/v1 except webhook deliveries/i, /every api route/i],
  ];

  it.each(CORRECTED)('%s describes what the bucket really charges', async (name, keyType, mustSay, mustNotSay) => {
    store.rateLimits = [rule(name, keyType, name)];
    await render();
    const text = await hoverDescription(name);
    expect(text).toMatch(mustSay);
    if (mustNotSay) expect(text).not.toMatch(mustNotSay);
  });
});

describe('AdminRateLimits — table and reset help', () => {
  it('the time-window help describes a fixed window from the first counted request, not a rolling one', async () => {
    await render();
    const tip = Array.from(document.body.querySelectorAll('thead th'))
      .find((th) => th.textContent?.includes('Time Window'))!
      .querySelector('.cursor-help') as HTMLElement;
    await act(async () => {
      tip.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }));
    });
    const text = Array.from(document.body.children).filter((el) => el !== container).map((el) => el.textContent ?? '').join('');
    expect(text).toMatch(/starts at the first counted request/i);
    expect(text).not.toMatch(/rolling/i);
  });

  it('the reset field says it takes an e-mail too (clearUserRateLimits clears its sign-in buckets)', async () => {
    await render();
    const input = document.body.querySelector('form input[type="text"]') as HTMLInputElement;
    expect(input.placeholder).toBe('User ID, IP address or e-mail');
    expect(document.body.textContent).toContain('user ID, IP address or e-mail address');
  });
});
