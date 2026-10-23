import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { LIMITS } from '@voxium/shared';
import { renderGitHubEvent, verifyGitHubSignature, type GitHubRender } from '../../../utils/webhooks/githubFormatter';
import { bareLinkRuns, outsideCodeSpans } from './bareLinkRuns';

// utils/webhooks/githubFormatter.ts — the GitHub signature check and the
// event formatter, over realistic payloads (fixtures/github/*.json: a
// fictional repository, acme/rocket).

const FIXTURES = path.resolve(__dirname, '../../fixtures/github');
const BS = String.fromCharCode(0x5c); // one backslash, spelled out
const DOT = ` ${String.fromCharCode(0xb7)} `; // the commit-line separator
const ELLIPSIS = String.fromCharCode(0x2026);
const NL = '\n';

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8'));
}

function content(result: GitHubRender): string {
  if (!('content' in result)) throw new Error(`expected content, got ${JSON.stringify(result)}`);
  return result.content;
}

function render(event: string, payload: unknown): string {
  return content(renderGitHubEvent(event, payload));
}

/** Every markdown link destination in `md` (an unescaped `](`), as written. */
function linkTargets(md: string): string[] {
  return Array.from(md.matchAll(/(?<!\\)\]\(((?:\\.|[^\\)])*)\)/g), (m) => m[1].replace(/\\(.)/g, '$1'));
}

/** Every fixture that renders a message: [event, fixture name]. */
const RENDERED_FIXTURES: Array<[string, string]> = [
  ['ping', 'ping'], ['ping', 'ping-org'], ['push', 'push-branch'], ['push', 'push-many'], ['push', 'push-created'],
  ['push', 'push-deleted'], ['push', 'push-tag'], ['push', 'push-hostile'], ['pull_request', 'pull_request-opened'],
  ['pull_request', 'pull_request-draft'], ['pull_request', 'pull_request-merged'], ['pull_request', 'pull_request-closed'],
  ['pull_request', 'pull_request-reopened'], ['pull_request', 'pull_request-ready'], ['issues', 'issues-opened'],
  ['issues', 'issues-closed'], ['issues', 'issues-reopened'], ['release', 'release-published'],
];

const REPO = { full_name: 'acme/rocket', html_url: 'https://github.com/acme/rocket' };
const SENDER = { login: 'wile-e' };
const SHA = '6f3eb107528fc9654bcd9008e6dbcb097a74755e';

function pushOf(commits: unknown[], extra: Record<string, unknown> = {}) {
  return {
    ref: 'refs/heads/main',
    compare: 'https://github.com/acme/rocket/compare/a...b',
    repository: REPO,
    sender: SENDER,
    created: false,
    deleted: false,
    commits,
    ...extra,
  };
}

// ─── Signature ──────────────────────────────────────────────────────────────

describe('verifyGitHubSignature', () => {
  const SECRET = 'c0ffee'.repeat(10) + 'beef';
  const body = Buffer.from(JSON.stringify(fixture('push-branch')));
  const sign = (buf: Buffer, secret = SECRET) => `sha256=${crypto.createHmac('sha256', secret).update(buf).digest('hex')}`;

  it('accepts the HMAC-SHA256 of the exact bytes under the secret', () => {
    expect(verifyGitHubSignature(body, sign(body), SECRET)).toBe(true);
  });

  it('accepts the digest in upper-case hex too', () => {
    const header = sign(body);
    expect(verifyGitHubSignature(body, `sha256=${header.slice(7).toUpperCase()}`, SECRET)).toBe(true);
  });

  it('rejects a missing header', () => {
    expect(verifyGitHubSignature(body, undefined, SECRET)).toBe(false);
    expect(verifyGitHubSignature(body, '', SECRET)).toBe(false);
  });

  it('rejects a signature made with another secret', () => {
    expect(verifyGitHubSignature(body, sign(body, 'not-the-secret'), SECRET)).toBe(false);
  });

  it('rejects a body changed by one byte after signing', () => {
    const header = sign(body);
    const tampered = Buffer.from(body);
    tampered[10] = tampered[10] ^ 0x01;
    expect(verifyGitHubSignature(tampered, header, SECRET)).toBe(false);
    expect(verifyGitHubSignature(Buffer.concat([body, Buffer.from(' ')]), header, SECRET)).toBe(false);
  });

  it('rejects a header of the wrong length, never throwing', () => {
    const header = sign(body);
    expect(verifyGitHubSignature(body, header.slice(0, -2), SECRET)).toBe(false);
    expect(verifyGitHubSignature(body, `${header}00`, SECRET)).toBe(false);
    expect(verifyGitHubSignature(body, 'sha256=abcd', SECRET)).toBe(false);
  });

  it('rejects the digest without the sha256= prefix, or with another algorithm', () => {
    const hex = sign(body).slice(7);
    expect(verifyGitHubSignature(body, hex, SECRET)).toBe(false);
    expect(verifyGitHubSignature(body, `sha1=${hex}`, SECRET)).toBe(false);
    expect(verifyGitHubSignature(body, `SHA256=${hex}`, SECRET)).toBe(false);
    expect(verifyGitHubSignature(body, ` sha256=${hex}`, SECRET)).toBe(false);
  });

  it('rejects 64 non-hex characters', () => {
    expect(verifyGitHubSignature(body, `sha256=${'z'.repeat(64)}`, SECRET)).toBe(false);
  });

  it('rejects everything under an empty secret, and a body that is not a Buffer', () => {
    expect(verifyGitHubSignature(body, sign(body, ''), '')).toBe(false);
    expect(verifyGitHubSignature(body.toString('utf8') as unknown as Buffer, sign(body), SECRET)).toBe(false);
  });
});

// ─── The fixtures ───────────────────────────────────────────────────────────

describe('renderGitHubEvent — fixtures', () => {
  it('ping: Connected to the repository', () => {
    expect(renderGitHubEvent('ping', fixture('ping'))).toEqual({ content: 'Connected to **acme/rocket**' });
  });

  it('ping of an organisation hook: Connected to the organisation', () => {
    expect(render('ping', fixture('ping-org'))).toBe('Connected to **acme**');
  });

  it('push to a branch: the header and one line per commit (first line of each message, escaped)', () => {
    expect(render('push', fixture('push-branch'))).toBe([
      '**wile-e** pushed 3 commits to `main` in [acme/rocket](https://github.com/acme/rocket/compare/a29932870447...4a35f9f0701e)',
      `[\`6f3eb10\`](https://github.com/acme/rocket/commit/6f3eb107528fc9654bcd9008e6dbcb097a74755e) Add launch countdown timer${DOT}Wile E. Coyote`,
      `[\`f33c953\`](https://github.com/acme/rocket/commit/f33c95329ec47c875b0f4834e54f138f26868046) Bump fuse${BS}_length to 3 ${BS}(${BS}#57${BS})${DOT}Wile E. Coyote`,
      `[\`4a35f9f\`](https://github.com/acme/rocket/commit/4a35f9f0701ed8182c988f6302f176ce03a92757) Fix ${BS}\`npm test${BS}\` on CI${DOT}Road Runner`,
    ].join(NL));
  });

  it('push of 7 commits: five lines, then "and 2 more"', () => {
    expect(render('push', fixture('push-many'))).toBe([
      '**roadrunner** pushed 7 commits to `feature/thrusters` in [acme/rocket](https://github.com/acme/rocket/compare/4a35f9f0701e...452c1a354cd8)',
      `[\`95782df\`](https://github.com/acme/rocket/commit/95782df3548ee1abd26af367178b0bccf518efa7) Sketch thruster mount${DOT}Road Runner`,
      `[\`145b946\`](https://github.com/acme/rocket/commit/145b94622786146ca542bf7c7c9d1d23bf457e22) Add thrust vector control${DOT}Road Runner`,
      `[\`53acd2a\`](https://github.com/acme/rocket/commit/53acd2a1ab01b39b8ea38dedb2fc6de8ba18b8fd) Wire throttle to the stick${DOT}Road Runner`,
      `[\`1a3c07e\`](https://github.com/acme/rocket/commit/1a3c07e2af61905f6a725b4d982112db1f64df02) Tune PID gains${DOT}Road Runner`,
      `[\`be1df84\`](https://github.com/acme/rocket/commit/be1df8461bc85dfbac140a7ae37d75a32e4df596) Add exhaust plume shader${DOT}Road Runner`,
      `${ELLIPSIS} and 2 more`,
    ].join(NL));
  });

  it('push creating a branch without new commits', () => {
    expect(render('push', fixture('push-created'))).toBe('**roadrunner** created branch `feature/parachute` in acme/rocket');
  });

  it('push deleting a branch', () => {
    expect(render('push', fixture('push-deleted'))).toBe('**wile-e** deleted branch `old-booster` in acme/rocket');
  });

  it('push of a tag', () => {
    expect(render('push', fixture('push-tag'))).toBe('**marvin** pushed tag `v1.2.0` to acme/rocket');
  });

  it('pull_request opened / draft / merged / closed / reopened / ready_for_review', () => {
    expect(render('pull_request', fixture('pull_request-opened')))
      .toBe('**roadrunner** opened pull request [#412 Add stage separation](https://github.com/acme/rocket/pull/412) in acme/rocket');
    expect(render('pull_request', fixture('pull_request-draft')))
      .toBe('**wile-e** opened draft pull request [#413 WIP: Reusable boosters](https://github.com/acme/rocket/pull/413) in acme/rocket');
    expect(render('pull_request', fixture('pull_request-merged')))
      .toBe('**marvin** merged pull request [#412 Add stage separation](https://github.com/acme/rocket/pull/412) in acme/rocket');
    expect(render('pull_request', fixture('pull_request-closed')))
      .toBe('**marvin** closed pull request [#410 Use solid fuel only](https://github.com/acme/rocket/pull/410) in acme/rocket');
    expect(render('pull_request', fixture('pull_request-reopened')))
      .toBe('**wile-e** reopened pull request [#410 Use solid fuel only](https://github.com/acme/rocket/pull/410) in acme/rocket');
    expect(render('pull_request', fixture('pull_request-ready')))
      .toBe('**wile-e** marked pull request [#413 WIP: Reusable boosters](https://github.com/acme/rocket/pull/413) ready for review in acme/rocket');
  });

  it('issues opened / closed / reopened', () => {
    expect(render('issues', fixture('issues-opened')))
      .toBe('**roadrunner** opened issue [#34 Countdown skips T-3](https://github.com/acme/rocket/issues/34) in acme/rocket');
    expect(render('issues', fixture('issues-closed')))
      .toBe('**marvin** closed issue [#34 Countdown skips T-3](https://github.com/acme/rocket/issues/34) in acme/rocket');
    expect(render('issues', fixture('issues-reopened')))
      .toBe('**roadrunner** reopened issue [#34 Countdown skips T-3](https://github.com/acme/rocket/issues/34) in acme/rocket');
  });

  it('release published: the tag, then the name', () => {
    expect(render('release', fixture('release-published')))
      .toBe('**marvin** published release [v1.2.0 Liftoff](https://github.com/acme/rocket/releases/tag/v1.2.0) in acme/rocket');
  });

  it.each([
    ['pull_request', 'pull_request-synchronize'],
    ['issues', 'issues-labeled'],
    ['release', 'release-created'],
    ['star', 'star'],
  ])('%s (%s) is ignored', (event, name) => {
    expect(renderGitHubEvent(event, fixture(name))).toEqual({ ignored: true });
  });

  // How many links each fixture must render, read off the fixture itself
  const EXPECTED_LINKS: Record<string, number> = {
    // a ping names the repository (or org) in bold, no link
    'ping': 0,
    'ping-org': 0,
    // the compare link on the headline + one link per listed commit (3 commits)
    'push-branch': 4,
    // the compare link + the 5 commits listed of 7 ("… and 2 more" is no link)
    'push-many': 6,
    // a branch created or deleted, a tag pushed: one line, no commits, no compare link
    'push-created': 0,
    'push-deleted': 0,
    'push-tag': 0,
    // every compare and commit url is foreign (or javascript:): none survives the pin
    'push-hostile': 0,
    // one link each: the pull request, the issue, the release
    'pull_request-opened': 1,
    'pull_request-draft': 1,
    'pull_request-merged': 1,
    'pull_request-closed': 1,
    'pull_request-reopened': 1,
    'pull_request-ready': 1,
    'issues-opened': 1,
    'issues-closed': 1,
    'issues-reopened': 1,
    'release-published': 1,
  };

  it('the expected-link table covers exactly the rendered fixtures', () => {
    expect(Object.keys(EXPECTED_LINKS).sort()).toEqual(RENDERED_FIXTURES.map(([, name]) => name).sort());
  });

  it('a push renders one link per listed commit, plus the compare link (read off the fixtures)', () => {
    for (const name of ['push-branch', 'push-many']) {
      const payload = fixture(name) as { commits: unknown[] };
      const md = render('push', payload);
      const listed = md.split('\n').filter((line) => line.startsWith('[`')).length;
      // the formatter lists the first 5 commits (COMMITS_SHOWN), then "… and N more"
      expect(listed, name).toBe(Math.min(payload.commits.length, 5));
      expect(linkTargets(md), name).toHaveLength(listed + 1);
    }
  });

  it.each(RENDERED_FIXTURES)('%s (%s) renders exactly its expected links, every one on https://github.com', (event, name) => {
    const targets = linkTargets(render(event, fixture(name)));
    expect(targets).toHaveLength(EXPECTED_LINKS[name]);
    for (const target of targets) {
      expect(new URL(target).origin).toBe('https://github.com');
    }
  });

  it.each(RENDERED_FIXTURES)('%s (%s) leaves no autolinkable run outside a code span', (event, name) => {
    expect(bareLinkRuns(render(event, fixture(name)))).toEqual([]);
  });
});

// ─── The hostile push ───────────────────────────────────────────────────────

describe('renderGitHubEvent — a hostile push (fixtures/github/push-hostile.json)', () => {
  const md = render('push', fixture('push-hostile'));

  it('renders exactly this', () => {
    expect(md).toBe([
      "**mallory** pushed 4 commits to `feat/'whoami'` in acme/rocket",
      `Totally safe${BS}]${BS}(\`https://evil.example\`${BS}) ${BS}[login${BS}]${BS}(\`https://evil.example/phish\`${BS})`
        + `${DOT}Mallory &lt;script&gt;alert${BS}(1${BS})&lt;/script&gt;`,
      `\`500c61c\` Point the label elsewhere${DOT}Eve`,
      `\`92176da\` Run a script${DOT}Eve`,
      `\`38a8db3\` ${BS}*${BS}*not bold${BS}*${BS}* and ${BS}_not italic${BS}_ &lt;img src=x onerror=alert${BS}(1${BS})&gt;${DOT}Eve`,
    ].join(NL));
  });

  it('renders no link except pinned ones, and no autolinkable run outside a code span', () => {
    // Pinned ones: none here, every compare and commit url is foreign (or javascript:)
    expect(linkTargets(md)).toEqual([]);
    expect(md).not.toContain('](http');
    expect(md).not.toContain('javascript:');
    expect(md).toContain('in acme/rocket');
    // The commit message's URLs would autolink by themselves (GFM needs no
    // markup for that): they sit in code spans, where nothing is linked
    expect(bareLinkRuns(md)).toEqual([]);
    expect(md).toContain('`https://evil.example`');
    expect(md).toContain('`https://evil.example/phish`');
  });

  it('neutralises the ]( in the commit message (escaped, so it cannot close or open a link)', () => {
    expect(md).not.toContain('](https://evil');
    expect(md).toContain(`${BS}]${BS}(\`https://evil.example\`${BS})`);
  });

  it('neutralises the backtick in the branch name (a code span cannot escape one)', () => {
    expect(md.split(NL)[0]).toContain("`feat/'whoami'`");
    expect(md.split(NL)[0].split('`')).toHaveLength(3);
  });

  it('a non-hex commit id is neither shown nor linked', () => {
    expect(md).not.toContain('not-a-sha');
    expect(md.split(NL)[1].startsWith('Totally safe')).toBe(true);
  });

  it('writes tags in author names and messages as text (entities, never raw), and keeps only the first line', () => {
    expect(md).not.toContain('<script');
    expect(md).not.toContain('<img');
    expect(md).toContain('Mallory &lt;script&gt;');
    expect(outsideCodeSpans(md)).not.toMatch(/[<>]/);
    expect(md).not.toContain('nothing to see here');
  });
});

// ─── Links ──────────────────────────────────────────────────────────────────

describe('renderGitHubEvent — link targets', () => {
  const pr = (html_url: unknown, repository: unknown = REPO) => render('pull_request', {
    action: 'opened',
    pull_request: { number: 7, title: 'Thing', html_url },
    repository,
    sender: SENDER,
  });

  it('keeps a github.com link', () => {
    expect(pr('https://github.com/acme/rocket/pull/7'))
      .toBe('**wile-e** opened pull request [#7 Thing](https://github.com/acme/rocket/pull/7) in acme/rocket');
  });

  it.each([
    ['another host', 'https://evil.example/acme/rocket/pull/7'],
    ['a look-alike host', 'https://github.com.evil.example/acme/rocket/pull/7'],
    ['userinfo hiding the host', 'https://github.com@evil.example/acme/rocket/pull/7'],
    ['plain http on github.com', 'http://github.com/acme/rocket/pull/7'],
    ['javascript:', 'javascript:alert(1)'],
    ['a relative url', '/acme/rocket/pull/7'],
    ['a non-string', 7],
    ['nothing', undefined],
  ])('drops a link to %s and keeps the label', (_label, url) => {
    expect(pr(url)).toBe('**wile-e** opened pull request #7 Thing in acme/rocket');
  });

  it("allows the repository's own origin (GitHub Enterprise) besides github.com, nothing else", () => {
    const ghe = { full_name: 'acme/rocket', html_url: 'https://ghe.acme.example/acme/rocket' };
    expect(pr('https://ghe.acme.example/acme/rocket/pull/7', ghe))
      .toBe('**wile-e** opened pull request [#7 Thing](https://ghe.acme.example/acme/rocket/pull/7) in acme/rocket');
    expect(pr('https://github.com/acme/rocket/pull/7', ghe)).toContain('[#7 Thing](https://github.com/acme/rocket/pull/7)');
    expect(pr('https://evil.example/pull/7', ghe)).toBe('**wile-e** opened pull request #7 Thing in acme/rocket');
  });

  it('a repository html_url that is not http(s) adds no origin', () => {
    const odd = { full_name: 'acme/rocket', html_url: 'javascript:alert(1)' };
    expect(pr('https://github.com/acme/rocket/pull/7', odd)).toContain('](https://github.com/acme/rocket/pull/7)');
  });

  it('escapes parentheses in a link destination so it cannot end early', () => {
    expect(pr('https://github.com/acme/rocket/pull/7)(x')).toContain(`](https://github.com/acme/rocket/pull/7${BS})${BS}(x)`);
  });

  it('a foreign compare url leaves the repository name as plain text', () => {
    expect(render('push', pushOf([], { compare: 'https://evil.example/compare' })))
      .toBe('**wile-e** pushed to `main` in acme/rocket');
  });

  it('a commit with a valid id but a foreign url shows its short sha unlinked', () => {
    const md = render('push', pushOf([{ id: SHA, url: 'https://evil.example/commit/x', message: 'Fix', author: { name: 'Wile' } }]));
    expect(md.split(NL)[1]).toBe(`\`6f3eb10\` Fix${DOT}Wile`);
  });
});

// ─── Pushes ─────────────────────────────────────────────────────────────────

describe('renderGitHubEvent — push details', () => {
  const commit = (message: unknown, extra: Record<string, unknown> = {}) => ({
    id: SHA,
    url: `https://github.com/acme/rocket/commit/${SHA}`,
    message,
    author: { name: 'Wile' },
    ...extra,
  });

  it('one commit is "1 commit"', () => {
    expect(render('push', pushOf([commit('Fix')])).split(NL)[0])
      .toBe('**wile-e** pushed 1 commit to `main` in [acme/rocket](https://github.com/acme/rocket/compare/a...b)');
  });

  it('exactly five commits: five lines, no "more" line', () => {
    const lines = render('push', pushOf(Array.from({ length: 5 }, () => commit('Fix')))).split(NL);
    expect(lines).toHaveLength(6);
    expect(lines[5]).toBe(`[\`6f3eb10\`](https://github.com/acme/rocket/commit/${SHA}) Fix${DOT}Wile`);
  });

  it('a push without commits that created nothing still says where', () => {
    expect(render('push', pushOf([]))).toBe('**wile-e** pushed to `main` in [acme/rocket](https://github.com/acme/rocket/compare/a...b)');
  });

  it('a created branch WITH commits is a push of those commits', () => {
    expect(render('push', pushOf([commit('Fix')], { created: true })).split(NL)[0]).toContain('pushed 1 commit to `main`');
  });

  it('a deleted tag', () => {
    expect(render('push', pushOf([], { ref: 'refs/tags/v0.9.0', deleted: true })))
      .toBe('**wile-e** deleted tag `v0.9.0` in acme/rocket');
  });

  it('keeps only the first line of a commit message, whatever the line break', () => {
    for (const br of ['\n', '\r\n', '\r', String.fromCharCode(0x2028), String.fromCharCode(0x85)]) {
      expect(render('push', pushOf([commit(`Subject${br}Body text`)])).split(NL)[1])
        .toBe(`[\`6f3eb10\`](https://github.com/acme/rocket/commit/${SHA}) Subject${DOT}Wile`);
    }
  });

  it('caps a long first line at 100 characters with an ellipsis', () => {
    const line = render('push', pushOf([commit('a'.repeat(150))])).split(NL)[1];
    expect(line).toBe(`[\`6f3eb10\`](https://github.com/acme/rocket/commit/${SHA}) ${'a'.repeat(99)}${ELLIPSIS}${DOT}Wile`);
  });

  it('a 100-character first line is kept whole; a cut never splits a surrogate pair', () => {
    expect(render('push', pushOf([commit('b'.repeat(100))]))).toContain(` ${'b'.repeat(100)}${DOT}`);
    const rocket = String.fromCodePoint(0x1f680);
    const line = render('push', pushOf([commit(rocket.repeat(120))])).split(NL)[1];
    expect(line).toContain(` ${rocket.repeat(99)}${ELLIPSIS}${DOT}`);
  });

  it('shows the short sha in lower case; an id that is not 7-64 hex is skipped', () => {
    const upper = render('push', pushOf([commit('Fix', { id: SHA.toUpperCase() })])).split(NL)[1];
    expect(upper.startsWith('[`6f3eb10`](')).toBe(true);
    for (const id of ['abc12', 'g'.repeat(40), 42, undefined, 'a'.repeat(65)]) {
      expect(render('push', pushOf([commit('Fix', { id })])).split(NL)[1]).toBe(`Fix${DOT}Wile`);
    }
  });

  it('a line starting with sender text cannot become a list item or a setext underline', () => {
    const line = (message: string) => render('push', pushOf([commit(message, { id: 'nope' })])).split(NL)[1];
    expect(line('1. Fix')).toBe(`1${BS}. Fix${DOT}Wile`);
    expect(line('2) Fix')).toBe(`2${BS}) Fix${DOT}Wile`);
    expect(line('- item')).toBe(`${BS}- item${DOT}Wile`);
    expect(line('+ item')).toBe(`${BS}+ item${DOT}Wile`);
    expect(line('===')).toBe(`${BS}===${DOT}Wile`);
  });

  it('falls back to the author username, and omits a missing author', () => {
    expect(render('push', pushOf([commit('Fix', { author: { username: 'wile-e' } })])).split(NL)[1]).toMatch(/ Fix · wile-e$/);
    expect(render('push', pushOf([commit('Fix', { author: null })])).split(NL)[1]).toMatch(/\) Fix$/);
  });

  it('counts non-object commits but renders no line for them', () => {
    const lines = render('push', pushOf([null, 'x', commit('Fix')])).split(NL);
    expect(lines[0]).toContain('pushed 3 commits');
    expect(lines).toHaveLength(2);
  });

  it('a push without a ref or a repository leaves those words out', () => {
    expect(render('push', { sender: SENDER, commits: [] })).toBe('**wile-e** pushed');
  });

  it('a branch name: tags stripped, backticks replaced, other characters verbatim inside the code span', () => {
    expect(render('push', pushOf([], { ref: 'refs/heads/a_b*c<i>d`e' })))
      .toBe("**wile-e** pushed to `a_b*cd'e` in [acme/rocket](https://github.com/acme/rocket/compare/a...b)");
  });

  it('a < in the branch and a > in a commit message both survive the final sanitising pass', () => {
    const md = render('push', pushOf([commit('x > y')], { ref: 'refs/heads/a<b' }));
    expect(md.split(NL)[0]).toContain('`a<b`');
    expect(md.split(NL)[1]).toContain(' x &gt; y');
  });

  // Escaping multiplies a field (a `<` is written `&lt;`), so five commits
  // of 100 `<` with 100-`>` authors render ~900 characters each: the old
  // renderer cut nothing and refused the whole push for length
  const NAME_MAX_POINTS = 100; // the formatter's cap on logins, names, repositories and refs
  const hostileCommit = (i: number) => commit('<'.repeat(100), { author: { name: '>'.repeat(100) }, id: `${SHA.slice(0, 39)}${i}` });
  const LONG_REPO = { full_name: `acme/${'r'.repeat(95)}`, html_url: 'https://github.com/acme/rocket' };
  const hostileLine = `[\`6f3eb10\`](https://github.com/acme/rocket/commit/${SHA}) ${'&lt;'.repeat(100)}${DOT}${'&gt;'.repeat(100)}`;
  const longHeader = (n: number) =>
    `**wile-e** pushed ${n} commits to \`main\` in [acme/${'r'.repeat(95)}](https://github.com/acme/rocket/compare/a...b)`;

  it('never refuses a push for length: five hostile commit lines on a long repository name are cut short, not refused', () => {
    const result = renderGitHubEvent('push', pushOf([1, 2, 3, 4, 5].map(hostileCommit), { repository: LONG_REPO }));

    const md = content(result);
    expect(md.length).toBeLessThanOrEqual(LIMITS.MESSAGE_MAX);
    // the header intact, as many whole lines as fit, the rest counted
    expect(md).toBe([longHeader(5), hostileLine, hostileLine, hostileLine, hostileLine, `${ELLIPSIS} and 1 more`].join(NL));
  });

  it('counts commits dropped for room AND commits past the first five into "and N more"', () => {
    const md = render('push', pushOf(Array.from({ length: 12 }, (_, i) => hostileCommit(i % 10)), { repository: LONG_REPO }));

    const lines = md.split(NL);
    expect(md.length).toBeLessThanOrEqual(LIMITS.MESSAGE_MAX);
    expect(lines[0]).toBe(longHeader(12));
    expect(lines.slice(1, -1)).toEqual([hostileLine, hostileLine, hostileLine, hostileLine]);
    expect(lines.at(-1)).toBe(`${ELLIPSIS} and 8 more`);
  });

  it('room is kept for the "more" line, never spent on a commit line', () => {
    // After four hostile lines the push is 3,773 characters: a 215-character
    // fifth line fits by itself (3,989), but not with the "more" line a sixth
    // commit needs, so with a sixth the fifth is counted instead
    const short = commit('x'.repeat(100), { author: { name: 'y'.repeat(20) } });
    const shortLine = `[\`6f3eb10\`](https://github.com/acme/rocket/commit/${SHA}) ${'x'.repeat(100)}${DOT}${'y'.repeat(20)}`;
    const four = [1, 2, 3, 4].map(hostileCommit);

    const five = render('push', pushOf([...four, short], { repository: LONG_REPO }));
    expect(five).toBe([longHeader(5), hostileLine, hostileLine, hostileLine, hostileLine, shortLine].join(NL));
    expect(five).toHaveLength(3989);

    const six = render('push', pushOf([...four, short, short], { repository: LONG_REPO }));
    expect(six).toBe([longHeader(6), hostileLine, hostileLine, hostileLine, hostileLine, `${ELLIPSIS} and 2 more`].join(NL));
  });

  it('a push that fits keeps every line of its first five commits and no "more" line', () => {
    const md = render('push', pushOf([1, 2, 3].map(hostileCommit), { repository: LONG_REPO }));
    expect(md.split(NL)).toEqual([longHeader(3), hostileLine, hostileLine, hostileLine]);
  });

  it('the header always fits: a maximal sender, branch and repository render; an oversized compare link is dropped, the repository still named', () => {
    const amp = '&'.repeat(NAME_MAX_POINTS);
    const rocket = String.fromCodePoint(0x1f680);
    const md = render('push', pushOf([hostileCommit(1)], {
      sender: { login: amp },
      ref: `refs/heads/${rocket.repeat(NAME_MAX_POINTS)}`,
      repository: { full_name: amp, html_url: 'https://github.com/acme/rocket' },
      compare: `https://github.com/acme/rocket/compare/${'a'.repeat(LIMITS.MESSAGE_MAX)}`,
    }));

    expect(md.length).toBeLessThanOrEqual(LIMITS.MESSAGE_MAX);
    const [header, line] = md.split(NL);
    expect(header).toBe(`**${'&amp;'.repeat(NAME_MAX_POINTS)}** pushed 1 commit to \`${rocket.repeat(NAME_MAX_POINTS)}\` in ${'&amp;'.repeat(NAME_MAX_POINTS)}`);
    expect(line).toBe(hostileLine);
  });

  it('a commit line longer than a whole message is counted, never posted cut', () => {
    const huge = commit('Fix', { url: `https://github.com/acme/rocket/commit/${'f'.repeat(LIMITS.MESSAGE_MAX)}` });
    expect(render('push', pushOf([huge, commit('Fix')]))).toBe([
      '**wile-e** pushed 2 commits to `main` in [acme/rocket](https://github.com/acme/rocket/compare/a...b)',
      `${ELLIPSIS} and 2 more`,
    ].join(NL));
  });
});

// ─── Autolinks ──────────────────────────────────────────────────────────────

describe('renderGitHubEvent — text remark-gfm would autolink by itself', () => {
  const commitWith = (message: unknown, author: unknown = { name: 'Wile' }) => render('push', pushOf([{
    id: SHA,
    url: `https://github.com/acme/rocket/commit/${SHA}`,
    message,
    author,
  }])).split(NL)[1];
  const prTitled = (title: string, html_url: unknown) => render('pull_request', {
    action: 'opened',
    pull_request: { number: 7, title, html_url },
    repository: REPO,
    sender: SENDER,
  });

  it('a commit subject with a GitHub issue URL keeps the URL whole in a code span, with no stray backslash', () => {
    const line = commitWith('Fixes https://github.com/acme/rocket/issues/12#issuecomment-1 for good');
    expect(line).toBe(
      `[\`6f3eb10\`](https://github.com/acme/rocket/commit/${SHA}) Fixes \`https://github.com/acme/rocket/issues/12#issuecomment-1\` for good${DOT}Wile`,
    );
    expect(bareLinkRuns(line)).toEqual([]);
  });

  it.each([
    ['a bare https URL', 'Login again at https://evil.example/login', 'Login again at `https://evil.example/login`'],
    ['a bare http URL in upper case', 'See HTTP://EVIL.EXAMPLE now', 'See `HTTP://EVIL.EXAMPLE` now'],
    ['a www. host', 'Mirror on www.evil.example', 'Mirror on `www.evil.example`'],
    ['an e-mail address', 'Write to x@evil.example today', 'Write to `x@evil.example` today'],
    ['a mailto: address', 'mailto:x@evil.example', 'mailto:`x@evil.example`'],
    ['an address with markdown characters', 'Ping x_y+z@evil.example', 'Ping `x_y+z@evil.example`'],
    ['a URL with a backtick', 'Go https://evil.example/a`b', `Go \`https://evil.example/a\`${BS}\`b`],
    ['a URL followed by punctuation', 'Read https://evil.example/x).', `Read \`https://evil.example/x\`${BS}).`],
    ['a URL with balanced parentheses', 'Wiki https://en.example.org/Foo_(bar)', 'Wiki `https://en.example.org/Foo_(bar)`'],
    ['a URL ending at an angle bracket', 'Go https://evil.example<x', 'Go `https://evil.example`&lt;x'],
  ])('%s in a commit subject sits verbatim in a code span', (_label, message, expected) => {
    const line = commitWith(message);
    expect(line).toBe(`[\`6f3eb10\`](https://github.com/acme/rocket/commit/${SHA}) ${expected}${DOT}Wile`);
    expect(bareLinkRuns(line)).toEqual([]);
  });

  it('an author name or username that is an address sits in a code span too', () => {
    expect(commitWith('Fix', { name: 'eve@evil.example' })).toMatch(/ Fix · `eve@evil\.example`$/);
    expect(commitWith('Fix', { username: 'www.evil.example' })).toMatch(/ Fix · `www\.evil\.example`$/);
  });

  it('a sender login, a repository name and an organisation are neutralised where they are plain text', () => {
    const repo = { full_name: 'acme/www.evil.example', html_url: 'https://github.com/acme/rocket' };
    expect(render('push', { ref: 'refs/tags/v1', repository: repo, sender: { login: 'x@evil.example' } }))
      .toBe('**`x@evil.example`** pushed tag `v1` to acme/`www.evil.example`');
    expect(render('ping', { organization: { login: 'https://evil.example' } })).toBe('Connected to **`https://evil.example`**');
    expect(render('issues', { action: 'opened', issue: { number: 1, title: 'T' }, repository: repo, sender: SENDER }))
      .toBe('**wile-e** opened issue #1 T in acme/`www.evil.example`');
  });

  it('a repository name that labels the compare link is a link label: written, not put in a code span', () => {
    const repo = { full_name: 'acme/www.evil.example', html_url: 'https://github.com/acme/rocket' };
    expect(render('push', pushOf([], { repository: repo })))
      .toBe('**wile-e** pushed to `main` in [acme/www.evil.example](https://github.com/acme/rocket/compare/a...b)');
  });

  it('a title whose link was dropped gets its URLs in code spans; a linked title stays a plain label', () => {
    const title = 'See https://evil.example/x and www.evil.example';
    const dropped = prTitled(title, 'https://evil.example/pull/7');
    expect(dropped).toBe('**wile-e** opened pull request #7 See `https://evil.example/x` and `www.evil.example` in acme/rocket');
    expect(bareLinkRuns(dropped)).toEqual([]);
    // GFM never autolinks inside a link: the label keeps the text as typed
    expect(prTitled(title, 'https://github.com/acme/rocket/pull/7'))
      .toBe('**wile-e** opened pull request [#7 See https://evil.example/x and www.evil.example](https://github.com/acme/rocket/pull/7) in acme/rocket');
  });

  it('a release whose link was dropped neutralises its tag and name', () => {
    expect(render('release', {
      action: 'published',
      release: { tag_name: 'v1', name: 'Notes at https://evil.example', html_url: 'https://evil.example/r' },
      repository: REPO,
      sender: SENDER,
    })).toBe('**wile-e** published release v1 Notes at `https://evil.example` in acme/rocket');
  });

  it('a clipped subject keeps the cut address in its code span', () => {
    // 40 + 1 + 21 + 60 characters, clipped to 99 and an ellipsis
    const line = commitWith(`${'a'.repeat(40)} https://evil.example/${'p'.repeat(60)}`);
    expect(line).toContain(` \`https://evil.example/${'p'.repeat(37)}${ELLIPSIS}\`${DOT}Wile`);
    expect(bareLinkRuns(line)).toEqual([]);
  });
});

// ─── Titles keep their characters ───────────────────────────────────────────

describe('renderGitHubEvent — angle brackets and ampersands in titles', () => {
  const prTitled = (title: string) => render('pull_request', {
    action: 'opened',
    pull_request: { number: 7, title, html_url: 'https://github.com/acme/rocket/pull/7' },
    repository: REPO,
    sender: SENDER,
  });

  it('a title with < and > keeps every character (as entities), nothing stripped as a tag', () => {
    const md = prTitled('Return Option<T> for a<b and c>d');
    expect(md).toBe('**wile-e** opened pull request [#7 Return Option&lt;T&gt; for a&lt;b and c&gt;d](https://github.com/acme/rocket/pull/7) in acme/rocket');
    expect(outsideCodeSpans(md)).not.toMatch(/[<>]/);
  });

  it('a title typed with entities shows them as typed (the & is encoded first)', () => {
    const md = prTitled('&lt;b&gt; &amp;');
    expect(md).toBe('**wile-e** opened pull request [#7 &amp;lt;b&amp;gt; &amp;amp;](https://github.com/acme/rocket/pull/7) in acme/rocket');
  });

  it('a < in one field and a > in a later one survive the final sanitising pass', () => {
    const md = render('push', pushOf([{ id: SHA, url: `https://github.com/acme/rocket/commit/${SHA}`, message: 'a < b', author: { name: 'c > d' } }], {
      sender: { login: '<x' },
    }));
    expect(md.split(NL)[0].startsWith('**&lt;x** pushed 1 commit')).toBe(true);
    expect(md.split(NL)[1]).toBe(`[\`6f3eb10\`](https://github.com/acme/rocket/commit/${SHA}) a &lt; b${DOT}c &gt; d`);
    expect(outsideCodeSpans(md)).not.toMatch(/[<>]/);
  });
});

// ─── Text escaping and missing fields ───────────────────────────────────────

describe('renderGitHubEvent — escaping and missing fields', () => {
  it('escapes markdown in titles and names, and writes tags and a lone < as entities (nothing stripped)', () => {
    expect(render('issues', {
      action: 'opened',
      issue: { number: 9, title: '**Bold** [x](https://evil.example) <b>tag</b> a < b', html_url: 'https://github.com/acme/rocket/issues/9' },
      repository: { full_name: 'acme/ro_cket', html_url: 'https://github.com/acme/ro_cket' },
      sender: { login: 'a_b' },
    })).toBe(
      `**a${BS}_b** opened issue [#9 ${BS}*${BS}*Bold${BS}*${BS}* ${BS}[x${BS}]${BS}(https://evil.example${BS}) &lt;b&gt;tag&lt;/b&gt; a &lt; b](https://github.com/acme/rocket/issues/9) in acme/ro${BS}_cket`,
    );
  });

  it('collapses line breaks in single-line fields', () => {
    expect(render('issues', {
      action: 'opened',
      issue: { number: 9, title: 'one\ntwo', html_url: 'https://github.com/acme/rocket/issues/9' },
      repository: REPO,
      sender: SENDER,
    })).toContain('[#9 one two](');
  });

  it('a missing sender login is "Someone"', () => {
    expect(render('push', { ref: 'refs/tags/v1', repository: REPO })).toBe('**Someone** pushed tag `v1` to acme/rocket');
    expect(render('push', { ref: 'refs/tags/v1', repository: REPO, sender: { login: 42 } })).toBe('**Someone** pushed tag `v1` to acme/rocket');
  });

  it('ping without a repository or an organisation', () => {
    expect(render('ping', { zen: 'Design for failure.', hook_id: 1 })).toBe('Connected to GitHub');
  });

  it('a pull request without number or title, or without its object', () => {
    expect(render('pull_request', { action: 'opened', pull_request: { html_url: 'https://github.com/x' }, repository: REPO, sender: SENDER }))
      .toBe('**wile-e** opened pull request in acme/rocket');
    expect(render('pull_request', { action: 'closed', repository: REPO, sender: SENDER }))
      .toBe('**wile-e** closed pull request in acme/rocket');
  });

  it('shows the number only when it is a positive integer', () => {
    for (const number of ['412', 1.5, -1, 0, Number.MAX_VALUE]) {
      expect(render('issues', { action: 'opened', issue: { number, title: 'T' }, repository: REPO, sender: SENDER }))
        .toBe('**wile-e** opened issue T in acme/rocket');
    }
  });

  it('a release whose name equals its tag, or has none, shows the tag once', () => {
    const rel = (name: unknown) => render('release', {
      action: 'published',
      release: { tag_name: 'v2.0.0', name, html_url: 'https://github.com/acme/rocket/releases/tag/v2.0.0' },
      repository: REPO,
      sender: SENDER,
    });
    expect(rel('v2.0.0')).toBe('**wile-e** published release [v2.0.0](https://github.com/acme/rocket/releases/tag/v2.0.0) in acme/rocket');
    expect(rel(null)).toBe('**wile-e** published release [v2.0.0](https://github.com/acme/rocket/releases/tag/v2.0.0) in acme/rocket');
    expect(rel('')).toBe('**wile-e** published release [v2.0.0](https://github.com/acme/rocket/releases/tag/v2.0.0) in acme/rocket');
  });

  it.each([
    ['pull_request', { action: 'edited' }],
    ['pull_request', { action: 'constructor' }],
    ['pull_request', { action: '__proto__' }],
    ['pull_request', {}],
    ['issues', { action: 'labeled' }],
    ['issues', { action: 'toString' }],
    ['issues', {}],
    ['release', { action: 'released' }],
    ['release', {}],
    ['workflow_run', { action: 'completed' }],
    ['issue_comment', { action: 'created' }],
    ['', {}],
  ])('ignores %s %j', (event, payload) => {
    expect(renderGitHubEvent(event, { ...payload, repository: REPO, sender: SENDER })).toEqual({ ignored: true });
  });

  it.each([
    ['null', null],
    ['an array', [{ ref: 'refs/heads/main' }]],
    ['a string', 'push'],
    ['a number', 42],
    ['undefined', undefined],
  ])('refuses a payload that is %s, whatever the event', (_label, payload) => {
    expect(renderGitHubEvent('push', payload)).toEqual({ error: 'Body must be a JSON object' });
    expect(renderGitHubEvent('star', payload)).toEqual({ error: 'Body must be a JSON object' });
  });
});
