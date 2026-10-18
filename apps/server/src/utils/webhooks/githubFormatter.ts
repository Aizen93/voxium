import crypto from 'crypto';
import { LIMITS, validateMessageContent } from '@voxium/shared';
import { sanitizeText } from '../sanitize';
import {
  collapseLineBreaks,
  encodeHtmlEntities,
  escapeLinkDestination,
  escapeMarkdown,
  neutraliseAutolinks,
  safeHttpUrl,
} from './markdown';
import type { WebhookPayloadError } from './discordPayload';

/**
 * The GitHub incoming-webhook formatter: verifies a delivery's signature and
 * turns the events worth a line in a channel (ping, push, pull_request,
 * issues, release) into ONE message's markdown content. Every other event,
 * and every other action of these, is acknowledged and IGNORED (noise).
 *
 * The payload is signed by GitHub, but much of it is written by whoever can
 * push to the repository (commit messages, branch names, titles, author
 * names), so every interpolated string is treated as hostile:
 * - one line, clipped, `&` `<` `>` written as entities (rendered as the
 *   characters: a title keeps its `Option<T>`), and markdown-significant
 *   characters backslash-escaped — so a commit message containing
 *   `](https://evil)` cannot close a link early;
 * - outside a link label, every run remark-gfm would autolink on its own (a
 *   bare URL, a `www.` host, an e-mail address) sits verbatim in a code
 *   span, where nothing is linked: no sender text can add a link;
 * - a branch or tag name sits in an inline code span, where no escape works,
 *   so its tags are stripped and its backticks replaced (a backtick would
 *   end the span early);
 * - every link target must be http(s) AND on the origin of the repository's
 *   html_url or on https://github.com, else the link is dropped and only its
 *   text stays: a payload cannot point a label at another host. The links a
 *   message carries are therefore exactly the pinned ones.
 * - a push is never refused for length: it shows fewer commit lines instead.
 *
 * Nothing here fetches anything. Pure functions: no I/O, no clock.
 */

export type GitHubRender = { content: string } | { ignored: true } | WebhookPayloadError;

const GITHUB_ORIGIN = 'https://github.com';
// What a delivery without a sender login is attributed to
const NEUTRAL_SENDER = 'Someone';
const COMMITS_SHOWN = 5;
const COMMIT_MESSAGE_MAX = 100;
const NAME_MAX = 100; // logins, author names, repository and organisation names
const REF_MAX = 100; // branch and tag names
const TITLE_MAX = 256; // GitHub's own title limit for issues and pull requests
const SHORT_SHA_LENGTH = 7;
// Built from code points: no raw separator, ellipsis or newline in the source.
// One line per entry: the desktop renders with remark-breaks, so a bare
// newline is a line break
const ELLIPSIS = String.fromCharCode(0x2026);
const SEPARATOR = ` ${String.fromCharCode(0xb7)} `;
const LINE_JOIN = String.fromCharCode(0x0a);
const BACKSLASH = String.fromCharCode(0x5c);

// sha256=<64 hex>, exactly what GitHub sends in X-Hub-Signature-256
const SIGNATURE_RE = /^sha256=([0-9a-fA-F]{64})$/;
// A git object id: SHA-1 (40) or SHA-256 (64) hex; 7+ so a short id passes
const SHA_RE = /^[0-9a-fA-F]{7,64}$/;
const REF_PREFIX_RE = /^refs\/(?:heads|tags)\//;
// The first line break of a commit message (LF, VT, FF, CR, NEL, U+2028,
// U+2029 — the set collapseLineBreaks() knows), built from code points
const LINE_BREAK_RE = new RegExp(
  `[${[0x0a, 0x0b, 0x0c, 0x0d, 0x85, 0x2028, 0x2029].map((cp) => String.fromCharCode(cp)).join('')}]`,
);
// Block syntax escapeMarkdown() leaves alone and that only matters at the
// start of a line: a list item (`- x`, `+ x`, `1. x`, `1) x`) or a setext
// underline (`===`, `---`) would restructure the message
const BULLET_START_RE = /^[-+=]/;
const ORDERED_START_RE = /^(\d+)([.)])/;

/**
 * True when `header` is `sha256=<hex>` and the hex is the HMAC-SHA256 of the
 * exact request bytes under `secret`. Compared in constant time on
 * equal-length buffers; a missing, malformed or wrong-length header is false,
 * never a throw.
 */
export function verifyGitHubSignature(rawBody: Buffer, header: string | undefined, secret: string): boolean {
  if (!Buffer.isBuffer(rawBody) || typeof header !== 'string' || typeof secret !== 'string' || secret === '') {
    return false;
  }
  const match = SIGNATURE_RE.exec(header);
  if (!match) return false;
  const presented = Buffer.from(match[1], 'hex');
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
  return presented.length === expected.length && crypto.timingSafeEqual(presented, expected);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** At most `max` code points (never splitting a surrogate pair), an ellipsis when cut. */
function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  // A code point is at most two UTF-16 units: 2 * max units hold at least
  // max code points, so the rest of a long string is never split up
  const points = Array.from(value.slice(0, max * 2));
  if (points.length <= max && value.length <= max * 2) return value;
  return `${points.slice(0, max - 1).join('').trimEnd()}${ELLIPSIS}`;
}

/** A sender string as one line: line breaks collapsed, trimmed, clipped; no markup applied yet. */
function oneLine(value: unknown, max: number): string {
  return clip(collapseLineBreaks(str(value)).trim(), max);
}

/** How a sender string is written into the markup: inside a link label, or anywhere else. */
type Format = (raw: string) => string;

/**
 * Inside a link label: `&`, `<` and `>` as entities (rendered as the
 * characters, so a title keeps its `Option<T>`), then the markdown escape —
 * the label cannot close its link early. GFM never autolinks inside a link.
 */
const labelText: Format = (raw) => escapeMarkdown(encodeHtmlEntities(raw));

/**
 * Anywhere else: like a label, except that every run GFM would autolink by
 * itself (a bare URL, a `www.` host, an e-mail address) sits verbatim in a
 * code span, so a commit message cannot add a link to another host.
 */
const proseText: Format = (raw) => neutraliseAutolinks(raw, labelText);

/**
 * A branch or tag name as an inline code span, or '' when there is none.
 * Inside a code span no backslash escape works, no entity is decoded and a
 * backtick would end the span (the rest rendering as markdown), so tags are
 * stripped, backticks replaced, and the other characters kept verbatim.
 */
function codeSpan(value: unknown, max: number): string {
  const name = clip(collapseLineBreaks(sanitizeText(str(value))).trim(), max).replace(/`/g, "'");
  return name === '' ? '' : `\`${name}\``;
}

/** The origins a link may point at: github.com and the repository's own (GitHub Enterprise). */
function allowedOrigins(payload: Record<string, unknown>): ReadonlySet<string> {
  const origins = new Set([GITHUB_ORIGIN]);
  const repoHref = isObject(payload.repository) ? safeHttpUrl(payload.repository.html_url) : null;
  if (repoHref) origins.add(new URL(repoHref).origin);
  return origins;
}

/**
 * `[label](url)` when the url is http(s) on an allowed origin, else the label
 * alone. Origins are compared parsed, never as a string prefix, so
 * `https://github.com.evil.example` and `https://github.com@evil.example`
 * do not pass for github.com. `label` writes the label in the format that
 * fits: labelText inside the link, proseText once the link is dropped.
 */
function link(url: unknown, origins: ReadonlySet<string>, label: (format: Format) => string): string {
  const href = safeHttpUrl(url);
  const linked = href !== null && origins.has(new URL(href).origin);
  const text = label(linked ? labelText : proseText);
  if (!linked || text === '') return text;
  return `[${text}](${escapeLinkDestination(href)})`;
}

/** The non-empty parts, space-separated. */
function words(...parts: string[]): string {
  return parts.filter((part) => part !== '').join(' ');
}

/** `preposition thing`, or '' when there is no thing. */
function phrase(preposition: string, thing: string): string {
  return thing === '' ? '' : `${preposition} ${thing}`;
}

function senderOf(payload: Record<string, unknown>): string {
  const login = isObject(payload.sender) ? proseText(oneLine(payload.sender.login, NAME_MAX)) : '';
  return `**${login || NEUTRAL_SENDER}**`;
}

/** `owner/repo` as one clipped line (not yet escaped), or '' when the payload names no repository. */
function repoOf(payload: Record<string, unknown>): string {
  return isObject(payload.repository) ? oneLine(payload.repository.full_name, NAME_MAX) : '';
}

/** Escape a list or setext marker at the start of a line that begins with sender text. */
function guardLineStart(line: string): string {
  if (BULLET_START_RE.test(line)) return `${BACKSLASH}${line}`;
  return line.replace(ORDERED_START_RE, (_m, digits: string, mark: string) => `${digits}${BACKSLASH}${mark}`);
}

function renderPing(payload: Record<string, unknown>): string {
  const repo = proseText(repoOf(payload));
  if (repo) return `Connected to **${repo}**`;
  // Organisation hooks carry no repository
  const org = isObject(payload.organization) ? proseText(oneLine(payload.organization.login, NAME_MAX)) : '';
  if (org) return `Connected to **${org}**`;
  return 'Connected to GitHub';
}

/** `[`a1b2c3d`](url) first line of the message · author`, or '' when nothing in it renders. */
function renderCommit(commit: unknown, origins: ReadonlySet<string>): string {
  if (!isObject(commit)) return '';
  const id = str(commit.id);
  // A non-hex id is no commit id: no short sha, no link
  const sha = SHA_RE.test(id)
    ? link(commit.url, origins, () => `\`${id.slice(0, SHORT_SHA_LENGTH).toLowerCase()}\``)
    : '';
  const rawMessage = str(commit.message);
  const breakAt = rawMessage.search(LINE_BREAK_RE);
  const message = proseText(oneLine(breakAt === -1 ? rawMessage : rawMessage.slice(0, breakAt), COMMIT_MESSAGE_MAX));
  const author = isObject(commit.author)
    ? proseText(oneLine(commit.author.name, NAME_MAX)) || proseText(oneLine(commit.author.username, NAME_MAX))
    : '';
  const line = [words(sha, message), author].filter((part) => part !== '').join(SEPARATOR);
  // Without the sha link the line starts with sender text
  return sha === '' ? guardLineStart(line) : line;
}

/** The last line of a push that shows fewer commits than it carries. */
function moreLine(hidden: number): string {
  return `${ELLIPSIS} and ${hidden} more`;
}

/**
 * A push: the header, one line per commit for the first COMMITS_SHOWN, then
 * `… and N more`. Never refused for length: a commit line is added only while
 * the whole push (header, lines, and room for the "more" line) stays within
 * MESSAGE_MAX, and every commit not shown counts into N. Escaping multiplies
 * a field (a `<` is written as four characters), so five hostile commit
 * lines can outgrow a message: they are then cut short here, instead of the
 * whole delivery being refused (a collaborator silencing their own push).
 */
function renderPush(payload: Record<string, unknown>, origins: ReadonlySet<string>): string {
  const sender = senderOf(payload);
  const repo = repoOf(payload);
  const ref = str(payload.ref);
  const name = codeSpan(ref.replace(REF_PREFIX_RE, ''), REF_MAX);

  if (ref.startsWith('refs/tags/')) {
    return payload.deleted === true
      ? words(sender, 'deleted tag', name, phrase('in', proseText(repo)))
      : words(sender, 'pushed tag', name, phrase('to', proseText(repo)));
  }

  const commits: unknown[] = Array.isArray(payload.commits) ? payload.commits : [];
  if (payload.deleted === true) return words(sender, 'deleted branch', name, phrase('in', proseText(repo)));
  if (payload.created === true && commits.length === 0) {
    return words(sender, 'created branch', name, phrase('in', proseText(repo)));
  }

  const count = commits.length;
  const verb = count === 0 ? 'pushed' : `pushed ${count} ${count === 1 ? 'commit' : 'commits'}`;
  const headerWith = (repoText: string) => words(sender, verb, phrase('to', name), phrase('in', repoText));
  // Room the "more" line may need: it never hides more than `count` commits
  const reserve = LINE_JOIN.length + moreLine(count).length;
  // The header always fits: the sender, branch and repository are clipped to
  // 100 code points each, so even fully escaped it is a few hundred
  // characters. Only the compare link has no such bound (the URL is GitHub's,
  // but nothing here trusts a length): when it would crowd out the push, the
  // repository is named without it
  let header = headerWith(link(payload.compare, origins, (format) => format(repo)));
  if (header.length + reserve > LIMITS.MESSAGE_MAX) header = headerWith(proseText(repo));

  const lines = [header];
  let used = header.length;
  // Commits taken in order: rendered, or skipped when nothing in them renders
  let taken = 0;
  for (const commit of commits.slice(0, COMMITS_SHOWN)) {
    const line = renderCommit(commit, origins);
    const lineLength = line === '' ? 0 : LINE_JOIN.length + line.length;
    // Any commit after this one is announced by the "more" line
    const moreFollows = count - taken - 1 > 0;
    if (used + lineLength + (moreFollows ? reserve : 0) > LIMITS.MESSAGE_MAX) break;
    if (line !== '') {
      lines.push(line);
      used += lineLength;
    }
    taken += 1;
  }
  if (count > taken) lines.push(moreLine(count - taken));
  return lines.join(LINE_JOIN);
}

/** `#412 Title`, the number only when it is a positive integer; '' when neither renders. */
function numberedLabel(item: Record<string, unknown>, format: Format): string {
  const number = typeof item.number === 'number' && Number.isSafeInteger(item.number) && item.number > 0
    ? `#${item.number}`
    : '';
  return words(number, format(oneLine(item.title, TITLE_MAX)));
}

/** The rendered actions: the verb before the link, and the words after it. */
const PULL_REQUEST_ACTIONS = new Map<string, (pr: Record<string, unknown>) => [string, string]>([
  ['opened', (pr) => [pr.draft === true ? 'opened draft pull request' : 'opened pull request', '']],
  ['closed', (pr) => [pr.merged === true ? 'merged pull request' : 'closed pull request', '']],
  ['reopened', () => ['reopened pull request', '']],
  ['ready_for_review', () => ['marked pull request', 'ready for review']],
]);

function renderPullRequest(payload: Record<string, unknown>, origins: ReadonlySet<string>): string | null {
  const verbs = PULL_REQUEST_ACTIONS.get(str(payload.action));
  if (!verbs) return null;
  const pr = isObject(payload.pull_request) ? payload.pull_request : {};
  const [verb, tail] = verbs(pr);
  const label = link(pr.html_url, origins, (format) => numberedLabel(pr, format));
  return words(senderOf(payload), verb, label, tail, phrase('in', proseText(repoOf(payload))));
}

const ISSUE_ACTIONS = new Set(['opened', 'closed', 'reopened']);

function renderIssue(payload: Record<string, unknown>, origins: ReadonlySet<string>): string | null {
  const action = str(payload.action);
  if (!ISSUE_ACTIONS.has(action)) return null;
  const issue = isObject(payload.issue) ? payload.issue : {};
  const label = link(issue.html_url, origins, (format) => numberedLabel(issue, format));
  return words(senderOf(payload), `${action} issue`, label, phrase('in', proseText(repoOf(payload))));
}

function renderRelease(payload: Record<string, unknown>, origins: ReadonlySet<string>): string | null {
  if (str(payload.action) !== 'published') return null;
  const release = isObject(payload.release) ? payload.release : {};
  const tag = oneLine(release.tag_name, REF_MAX);
  const name = oneLine(release.name, TITLE_MAX);
  const label = link(release.html_url, origins, (format) => words(format(tag), name !== tag ? format(name) : ''));
  return words(senderOf(payload), 'published release', label, phrase('in', proseText(repoOf(payload))));
}

/** The line(s) for one delivery, or null when the event or action posts nothing. */
function renderEvent(event: string, payload: Record<string, unknown>): string | null {
  const origins = allowedOrigins(payload);
  switch (event) {
    case 'ping':
      return renderPing(payload);
    case 'push':
      return renderPush(payload, origins);
    case 'pull_request':
      return renderPullRequest(payload, origins);
    case 'issues':
      return renderIssue(payload, origins);
    case 'release':
      return renderRelease(payload, origins);
    default:
      return null;
  }
}

/**
 * Render one GitHub delivery (`event` is the X-GitHub-Event header) into
 * message content, `{ ignored: true }` for an event or action that posts
 * nothing, or an error the route answers as 400. Missing or mistyped fields
 * are left out of the line, never thrown on.
 */
export function renderGitHubEvent(event: string, payload: unknown): GitHubRender {
  if (!isObject(payload)) return { error: 'Body must be a JSON object' };

  const rendered = renderEvent(event, payload);
  if (rendered === null) return { ignored: true };

  // No sender string carries a raw angle bracket outside the branch or tag
  // code span (whose tags are stripped), and link targets are
  // percent-encoded, so this pass only trims: it stays as the storage rule's
  // last line of defence
  const content = sanitizeText(rendered);
  const contentError = validateMessageContent(content);
  if (contentError) return { error: contentError };
  return { content };
}
