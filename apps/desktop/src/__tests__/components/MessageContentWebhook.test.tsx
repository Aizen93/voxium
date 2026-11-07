import { describe, it, expect, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MessageContent } from '../../components/chat/MessageContent';

/**
 * The server's webhook formatters (apps/server/src/utils/webhooks/) promise
 * that nothing a webhook sends makes a reader's client fetch or link a
 * third-party URL: every hostile address goes into a code span, because
 * remark-gfm autolinks bare URLs, `www.` hosts and e-mail addresses BY
 * ITSELF. The server tests check the markdown string; this checks what the
 * REAL renderer (react-markdown + remark-gfm + remark-breaks, the desktop's
 * MessageContent) makes of it.
 *
 * The inputs are copied verbatim from the server tests' pinned outputs —
 * githubFormatter.test.ts ("renders exactly this" for push-hostile, the
 * push-branch and autolink cases) and discordPayload.test.ts (the hostile
 * title, author, field and footer cases, and the rich embed) — and must be
 * kept in step with them.
 */

const BS = String.fromCharCode(0x5c); // one backslash
const DOT = ' ' + String.fromCharCode(0xb7) + ' '; // the GitHub commit-line separator
const MID = String.fromCharCode(0xb7); // the Discord footer separator
const BR = '  \n'; // the line join inside a flattened embed
const NL = '\n';
const SHA = '6f3eb107528fc9654bcd9008e6dbcb097a74755e';
const COMMIT_LINK = '[`6f3eb10`](https://github.com/acme/rocket/commit/' + SHA + ') ';

/** githubFormatter.test.ts — "renders exactly this" (fixtures/github/push-hostile.json) */
const GITHUB_PUSH_HOSTILE = [
  "**mallory** pushed 4 commits to `feat/'whoami'` in acme/rocket",
  'Totally safe' + BS + ']' + BS + '(`https://evil.example`' + BS + ') ' + BS + '[login' + BS + ']' + BS + '(`https://evil.example/phish`' + BS + ')'
    + DOT + 'Mallory &lt;script&gt;alert' + BS + '(1' + BS + ')&lt;/script&gt;',
  '`500c61c` Point the label elsewhere' + DOT + 'Eve',
  '`92176da` Run a script' + DOT + 'Eve',
  '`38a8db3` ' + BS + '*' + BS + '*not bold' + BS + '*' + BS + '* and ' + BS + '_not italic' + BS + '_ &lt;img src=x onerror=alert' + BS + '(1' + BS + ')&gt;' + DOT + 'Eve',
].join(NL);

/** githubFormatter.test.ts — "push to a branch" (fixtures/github/push-branch.json): the pinned links */
const GITHUB_PUSH_BRANCH = [
  '**wile-e** pushed 3 commits to `main` in [acme/rocket](https://github.com/acme/rocket/compare/a29932870447...4a35f9f0701e)',
  '[`6f3eb10`](https://github.com/acme/rocket/commit/6f3eb107528fc9654bcd9008e6dbcb097a74755e) Add launch countdown timer' + DOT + 'Wile E. Coyote',
  '[`f33c953`](https://github.com/acme/rocket/commit/f33c95329ec47c875b0f4834e54f138f26868046) Bump fuse' + BS + '_length to 3 ' + BS + '(' + BS + '#57' + BS + ')' + DOT + 'Wile E. Coyote',
  '[`4a35f9f`](https://github.com/acme/rocket/commit/4a35f9f0701ed8182c988f6302f176ce03a92757) Fix ' + BS + '`npm test' + BS + '` on CI' + DOT + 'Road Runner',
].join(NL);

/** githubFormatter.test.ts — "%s in a commit subject sits verbatim in a code span" (the expected column) */
const GITHUB_COMMIT_SUBJECTS = [
  'Login again at `https://evil.example/login`',
  'See `HTTP://EVIL.EXAMPLE` now',
  'Mirror on `www.evil.example`',
  'Write to `x@evil.example` today',
  'mailto:`x@evil.example`',
  'Ping `x_y+z@evil.example`',
  'Go `https://evil.example/a`' + BS + '`b',
  'Read `https://evil.example/x`' + BS + ').',
  'Go `https://evil.example`&lt;x',
].map((subject) => COMMIT_LINK + subject + DOT + 'Wile');

/** discordPayload.test.ts — "puts every address in a single-line field in a code span: a title without url, the author, field names, the footer" */
const DISCORD_HOSTILE_FIELDS =
  '> _`ops@evil.example`_' + BR
  + '> **Down: `https://evil.example/login`**' + BR
  + '> **`www.evil.example`**' + BR
  + '> **Mirror `HTTP://EVIL.EXAMPLE/x`.**' + BR
  + '> _via `https://evil.example/a_(b)`_';

/** discordPayload.test.ts — "escapes a title containing ](https://evil) so it cannot close the link" */
const DISCORD_HOSTILE_TITLE = '> **[Click' + BS + ']' + BS + '(https://evil.example' + BS + ')](https://good.example/)**';

/** discordPayload.test.ts — "flattens one rich embed exactly as laid out" */
const DISCORD_RICH_EMBED =
  'Deploy finished\n\n'
  + '> _CI Bot_' + BR
  + '> **[Build ' + BS + '#42](https://ci.example.com/42)**' + BR
  + '> All green' + BR
  + '> **Branch**: main' + BR
  + '> **Duration**: 3m' + BR
  + '> _ci.example.com ' + MID + ' 2026-10-17 09:58_';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function render(content: string): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => { root!.render(<MessageContent content={content} />); });
  return container;
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

const links = (el: Element) => [...el.querySelectorAll('a')];
const hrefs = (el: Element) => links(el).map((a) => a.getAttribute('href') ?? '');

/** Every text node containing `needle` (case-insensitive), with whether a <code> encloses it. */
function occurrences(el: Element, needle: string): Array<{ text: string; inCode: boolean; inLink: boolean }> {
  const out: Array<{ text: string; inCode: boolean; inLink: boolean }> = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent ?? '';
    if (!text.toLowerCase().includes(needle.toLowerCase())) continue;
    const parent = node.parentElement!;
    out.push({ text, inCode: parent.closest('code') !== null, inLink: parent.closest('a') !== null });
  }
  return out;
}

/** The checks every rendering must pass: nothing to fetch, no script, no foreign link. */
function expectNothingFetched(el: Element) {
  expect(el.querySelector('img')).toBeNull();
  expect(el.querySelector('script')).toBeNull();
  expect(el.querySelector('iframe')).toBeNull();
  expect(el.querySelector('[src]')).toBeNull();
  for (const href of hrefs(el)) expect(href.toLowerCase()).not.toContain('evil.example');
}

describe('MessageContent renders the GitHub formatter\'s output without a foreign link', () => {
  it('the hostile push: no link at all, every evil.example in a <code>, the HTML shown as text', () => {
    const el = render(GITHUB_PUSH_HOSTILE);
    expectNothingFetched(el);
    expect(links(el)).toHaveLength(0);
    const evil = occurrences(el, 'evil.example');
    expect(evil.length).toBe(2);
    for (const o of evil) expect(o.inCode, o.text).toBe(true);
    expect([...el.querySelectorAll('code')].map((c) => c.textContent)).toEqual(expect.arrayContaining([
      'https://evil.example', 'https://evil.example/phish', "feat/'whoami'",
    ]));
    // the escaped markup stays literal text: the brackets, the would-be bold, the tags
    expect(el.textContent).toContain('Totally safe](https://evil.example) [login](https://evil.example/phish)');
    expect(el.textContent).toContain('**not bold** and _not italic_');
    expect(el.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(el.textContent).toContain('Mallory <script>alert(1)</script>');
    expect(el.querySelector('strong')!.textContent).toBe('mallory');
    expect(el.querySelectorAll('strong')).toHaveLength(1);
    expect(el.querySelector('em')).toBeNull();
  });

  it('a push to a branch: the pinned links are there, every one on https://github.com', () => {
    const el = render(GITHUB_PUSH_BRANCH);
    expectNothingFetched(el);
    expect(hrefs(el)).toEqual([
      'https://github.com/acme/rocket/compare/a29932870447...4a35f9f0701e',
      'https://github.com/acme/rocket/commit/6f3eb107528fc9654bcd9008e6dbcb097a74755e',
      'https://github.com/acme/rocket/commit/f33c95329ec47c875b0f4834e54f138f26868046',
      'https://github.com/acme/rocket/commit/4a35f9f0701ed8182c988f6302f176ce03a92757',
    ]);
    for (const href of hrefs(el)) expect(new URL(href).origin).toBe('https://github.com');
    expect(links(el).map((a) => a.textContent)).toEqual(['acme/rocket', '6f3eb10', 'f33c953', '4a35f9f']);
    // the opener gets nothing from the page
    for (const a of links(el)) expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    expect(el.textContent).toContain('Bump fuse_length to 3 (#57)');
    expect(el.textContent).toContain('Fix `npm test` on CI');
  });

  it.each(GITHUB_COMMIT_SUBJECTS.map((line) => [line]))('a commit subject that would autolink: only the commit link, the address in a <code> — %s', (line) => {
    const el = render(line);
    expectNothingFetched(el);
    expect(hrefs(el)).toEqual(['https://github.com/acme/rocket/commit/' + SHA]);
    const evil = occurrences(el, 'evil.example');
    expect(evil.length).toBeGreaterThan(0);
    for (const o of evil) {
      expect(o.inCode, o.text).toBe(true);
      expect(o.inLink, o.text).toBe(false);
    }
  });
});

describe('MessageContent renders the Discord payload\'s flattened embeds without a foreign link', () => {
  it('addresses in the author, a url-less title, field names and the footer: no link, each one in a <code>', () => {
    const el = render(DISCORD_HOSTILE_FIELDS);
    expectNothingFetched(el);
    expect(links(el)).toHaveLength(0);
    const evil = occurrences(el, 'evil.example');
    expect(evil.length).toBe(5);
    for (const o of evil) expect(o.inCode, o.text).toBe(true);
    expect([...el.querySelectorAll('code')].map((c) => c.textContent)).toEqual([
      'ops@evil.example', 'https://evil.example/login', 'www.evil.example', 'HTTP://EVIL.EXAMPLE/x', 'https://evil.example/a_(b)',
    ]);
    expect(el.querySelector('blockquote')).not.toBeNull();
  });

  it('a title smuggling ](https://evil.example): ONE link, to the embed\'s own url, the smuggled one plain text inside it', () => {
    const el = render(DISCORD_HOSTILE_TITLE);
    expectNothingFetched(el);
    expect(hrefs(el)).toEqual(['https://good.example/']);
    expect(links(el)[0].textContent).toBe('Click](https://evil.example)');
    // the address is the link's TEXT here, never a link of its own
    for (const o of occurrences(el, 'evil.example')) expect(o.inLink).toBe(true);
  });

  it('a rich embed: its own https link survives, nothing else is linked (not even the footer host)', () => {
    const el = render(DISCORD_RICH_EMBED);
    expectNothingFetched(el);
    expect(hrefs(el)).toEqual(['https://ci.example.com/42']);
    expect(new URL(hrefs(el)[0]).protocol).toBe('https:');
    expect(links(el)[0].textContent).toBe('Build #42');
    expect(el.textContent).toContain('ci.example.com ' + MID + ' 2026-10-17 09:58');
    expect(el.querySelector('blockquote')).not.toBeNull();
  });
});

describe('the renderer would link these by itself — why the code spans matter', () => {
  // Control: the SAME addresses outside a code span ARE linked by remark-gfm.
  // If this ever stops linking, the checks above prove nothing.
  it.each([
    ['a bare https URL', 'Login again at https://evil.example/login'],
    ['a www. host', 'Mirror on www.evil.example'],
    ['an e-mail address', 'Write to x@evil.example today'],
  ])('%s outside a code span becomes a link', (_label, text) => {
    const el = render(text);
    expect(hrefs(el).some((href) => href.includes('evil.example'))).toBe(true);
  });
});
