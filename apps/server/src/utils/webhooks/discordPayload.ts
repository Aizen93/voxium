import { LIMITS, validateMessageContent } from '@voxium/shared';
import { sanitizeText } from '../sanitize';
import {
  collapseLineBreaks,
  escapeLinkDestination,
  isObject,
  labelText,
  neutraliseAutolinks,
  safeHttpUrl,
} from './markdown';

/**
 * The generic incoming-webhook renderer: a Discord-shaped body
 * (`content`, `username`, `embeds[]`) becomes ONE message's markdown content.
 *
 * The Discord shape is the generic shape on purpose: every tool that matters
 * (Uptime Kuma, Grafana, Alertmanager, Gitea/Forgejo, GitLab, n8n, ...) ships
 * a Discord notifier, so "paste the URL where it asks for a Discord webhook"
 * is the whole setup. Everything this renderer does not understand is
 * IGNORED, never an error — that is what keeps every tool's payload working.
 *
 * Nothing here may make a reader's client fetch a third-party URL: avatar_url,
 * embed images/thumbnails/videos, author/footer icons are dropped. A link is a
 * plain anchor the reader chooses to click: the embed url is pinned to http(s)
 * here (safeHttpUrl); free text (content, description, field values) keeps its
 * markdown links as a member's message would, and the desktop renderer
 * (MessageContent.tsx, react-markdown's urlTransform) is what filters their
 * schemes, exactly as for a member's message.
 *
 * Pure function: no I/O, no clock.
 */

export interface WebhookPayloadError {
  error: string;
}

export interface RenderedWebhookMessage {
  content: string;
  /** The body's `username`, sanitised: the name this ONE message posts under. */
  nameOverride?: string;
}

// Lines of one embed are joined with two trailing spaces (a CommonMark hard
// break; remark-breaks would keep a bare newline too)
const LINE_JOIN = '  \n';
// Embeds are separated by a blank line, or consecutive blockquotes would merge
const BLOCK_JOIN = '\n\n';
// space, U+00B7 MIDDLE DOT, space — built from the code point, no raw
// separator character in the source
const FOOTER_SEPARATOR = ` ${String.fromCharCode(0xb7)} `;
// The line endings markdown itself recognises (a free-text field is split on
// them so every line of it can be prefixed with the blockquote marker)
const MARKDOWN_LINE_END_RE = /\r\n|\r|\n/;
// Discord's angle-bracket autolink (`<https://...>`, "link without preview").
// sanitizeText() would strip it as an HTML tag, so it is unwrapped first.
const ANGLE_AUTOLINK_RE = /<(https?:\/\/[^\s<>]+)>/gi;
// The text validateMessageContent() answers for over-long content: the early
// input bound below answers the same sentence, so a sender sees one error
const TOO_LONG_ERROR = `Message must be at most ${LIMITS.MESSAGE_MAX} characters`;
// The summed length of every string the renderer reads. Rendering only
// removes characters (tags, whitespace, unusable links) apart from a bounded
// amount of markup and escapes, so input this large cannot be a message that
// fits; refusing it up front bounds the sanitising and escaping work
const INPUT_TOTAL_MAX = LIMITS.MESSAGE_MAX * 2;
// Date or date-time in ISO 8601: group 1 = date, group 2 = offset
const ISO_TIMESTAMP_RE =
  /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?)(Z|[+-]\d{2}:?\d{2})?)?$/i;

type Encode = (text: string) => string;
const asIs: Encode = (text) => text;
// After per-string sanitising, a '<' left in a free-text string has no '>'
// after it WITHIN that string — but the final sanitizeText() pass over the
// combined content would then eat from it to the next '>' of OUR markup (a
// blockquote marker), destroying the layout and the text in between. On that
// (rare) path residual '<' are written as the entity '&lt;', which markdown
// displays as '<'. (Single-line fields never carry a raw '<': see labelText.)
const encodeLt: Encode = (text) => text.replace(/</g, '&lt;');

/** Free text, as a human message stores it: autolinks unwrapped, tags stripped, trimmed. */
function freeText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return sanitizeText(value.replace(ANGLE_AUTOLINK_RE, '$1'));
}

/** A single-line field as one line: angle-bracket autolinks unwrapped, line breaks collapsed, trimmed. */
function inlineRaw(value: unknown): string {
  if (typeof value !== 'string') return '';
  return collapseLineBreaks(value.replace(ANGLE_AUTOLINK_RE, '$1')).trim();
}

// A single-line field inside a link label (an embed title with a url) is
// written through labelText() (./markdown): entities, then the markdown escape.

/**
 * A single-line field anywhere else (a title without a url, the author name,
 * a field name, the footer text): like a label, except that every run GFM
 * would autolink by itself sits verbatim in a code span — a field the
 * renderer wraps in its own markup cannot add a link. Free text (content,
 * description, field values) is NOT passed through this: it stays as the
 * sender wrote it, like any human message.
 */
function inlineText(value: unknown): string {
  return neutraliseAutolinks(inlineRaw(value), labelText);
}

/** `YYYY-MM-DD HH:mm` in UTC, or '' for anything that is not a valid ISO 8601 timestamp. */
export function formatEmbedTimestamp(value: unknown): string {
  if (typeof value !== 'string') return '';
  const raw = value.trim();
  const match = ISO_TIMESTAMP_RE.exec(raw);
  if (!match) return '';
  const [, date, time, offset] = match;
  // Date() rolls 2026-02-31 over into March: refuse a day the month lacks
  const [y, m, d] = date.split('-').map(Number);
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return '';
  let normalised = date;
  if (time) {
    // A date-time without an offset is read as UTC (Date() would read it as
    // server-local time); a +HHMM offset gains the colon Date() expects
    let zone = offset ? offset.toUpperCase() : 'Z';
    if (/^[+-]\d{4}$/.test(zone)) zone = `${zone.slice(0, 3)}:${zone.slice(3)}`;
    normalised = `${date}T${time}${zone}`;
  }
  const parsed = new Date(normalised);
  if (Number.isNaN(parsed.getTime())) return '';
  const iso = parsed.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

/** One embed as blockquote lines (already prefixed), or [] when nothing in it renders. */
function renderEmbed(embed: Record<string, unknown>, enc: Encode): string[] {
  const lines: string[] = [];

  const authorName = isObject(embed.author) ? inlineText(embed.author.name) : '';
  if (authorName) lines.push(`_${enc(authorName)}_`);

  const title = inlineRaw(embed.title);
  if (title) {
    const href = safeHttpUrl(embed.url);
    lines.push(href
      ? `**[${enc(labelText(title))}](${escapeLinkDestination(href)})**`
      : `**${enc(neutraliseAutolinks(title, labelText))}**`);
  }

  const description = freeText(embed.description);
  if (description) lines.push(...enc(description).split(MARKDOWN_LINE_END_RE));

  if (Array.isArray(embed.fields)) {
    for (const field of embed.fields) {
      if (!isObject(field)) continue;
      const name = inlineText(field.name);
      const value = freeText(field.value);
      const valueLines = value ? enc(value).split(MARKDOWN_LINE_END_RE) : [];
      if (name) {
        const head = `**${enc(name)}**`;
        lines.push(valueLines.length > 0 ? `${head}: ${valueLines[0]}` : head, ...valueLines.slice(1));
      } else {
        lines.push(...valueLines);
      }
    }
  }

  const footerText = isObject(embed.footer) ? inlineText(embed.footer.text) : '';
  const timestamp = formatEmbedTimestamp(embed.timestamp);
  const footer = [footerText && enc(footerText), timestamp].filter(Boolean).join(FOOTER_SEPARATOR);
  if (footer) lines.push(`_${footer}_`);

  // Every line — including each line of a multi-line description or field
  // value — carries the marker, so sender text can never leave the blockquote
  return lines.map((line) => (line === '' ? '>' : `> ${line}`));
}

/**
 * True when a string the renderer would read is longer than MESSAGE_MAX, or
 * when all of them together exceed INPUT_TOTAL_MAX. Runs BEFORE any
 * sanitising or escaping and reads lengths only, so its cost is bounded by
 * the (already capped) number of embeds and fields, never by the text.
 */
function inputTooLong(body: Record<string, unknown>, embeds: unknown[]): boolean {
  let total = 0;
  let tooLong = false;
  const measure = (value: unknown): void => {
    if (typeof value !== 'string') return;
    if (value.length > LIMITS.MESSAGE_MAX) tooLong = true;
    total += value.length;
  };

  measure(body.content);
  measure(body.username);
  for (const embed of embeds) {
    if (!isObject(embed)) continue;
    measure(embed.title);
    measure(embed.url);
    measure(embed.description);
    measure(embed.timestamp);
    if (isObject(embed.author)) measure(embed.author.name);
    if (isObject(embed.footer)) measure(embed.footer.text);
    if (Array.isArray(embed.fields)) {
      for (const field of embed.fields) {
        if (!isObject(field)) continue;
        measure(field.name);
        measure(field.value);
      }
    }
  }
  return tooLong || total > INPUT_TOTAL_MAX;
}

/** The first WEBHOOK_NAME_MAX characters, never splitting a surrogate pair, trimmed. */
function truncateName(name: string): string {
  let cut = LIMITS.WEBHOOK_NAME_MAX;
  const last = name.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  return name.slice(0, cut).trim();
}

/** content, a blank line, then one blockquote per embed; null when nothing renders. */
function assemble(content: string, embeds: unknown[], enc: Encode): string | null {
  const blocks: string[] = [];
  for (const embed of embeds) {
    if (!isObject(embed)) continue;
    const lines = renderEmbed(embed, enc);
    if (lines.length > 0) blocks.push(lines.join(LINE_JOIN));
  }
  const parts = content ? [enc(content), ...blocks] : blocks;
  return parts.length > 0 ? parts.join(BLOCK_JOIN) : null;
}

/**
 * Render a Discord-shaped webhook body into message content, or an error the
 * route answers as 400. Over-long content is REJECTED, never truncated: an
 * alert that arrived cut would be worse than one that failed loudly in the
 * sender's delivery log. A long `username` is only a display name, so it is
 * cut to WEBHOOK_NAME_MAX (Discord accepts 80) instead of failing the delivery.
 */
export function renderDiscordPayload(body: unknown): RenderedWebhookMessage | WebhookPayloadError {
  if (!isObject(body)) return { error: 'Body must be a JSON object' };

  const embeds: unknown[] = Array.isArray(body.embeds) ? body.embeds : [];
  if (embeds.length > LIMITS.WEBHOOK_EMBEDS_MAX) {
    return { error: `embeds must contain at most ${LIMITS.WEBHOOK_EMBEDS_MAX} items` };
  }
  for (const embed of embeds) {
    if (isObject(embed) && Array.isArray(embed.fields) && embed.fields.length > LIMITS.WEBHOOK_EMBED_FIELDS_MAX) {
      return { error: `embed fields must contain at most ${LIMITS.WEBHOOK_EMBED_FIELDS_MAX} items` };
    }
  }

  // Before ANY sanitising or escaping: the work below is bounded by the input
  if (inputTooLong(body, embeds)) return { error: TOO_LONG_ERROR };

  let nameOverride: string | undefined;
  if (typeof body.username === 'string') {
    let name = sanitizeText(collapseLineBreaks(body.username));
    if (name.length > LIMITS.WEBHOOK_NAME_MAX) name = truncateName(name);
    if (name) nameOverride = name;
  }

  const content = freeText(body.content);
  const assembled = assemble(content, embeds, asIs);
  if (assembled === null) return { error: 'content or embeds required' };

  // Every sender string is already tag-free on its own; the pass over the
  // combined content only changes it when a lone '<' would reach across into
  // our markup (see encodeLt) — then assemble again with '<' encoded
  let rendered = sanitizeText(assembled);
  if (rendered !== assembled.trim()) {
    rendered = sanitizeText(assemble(content, embeds, encodeLt) ?? '');
  }

  const contentError = validateMessageContent(rendered);
  if (contentError) return { error: contentError };

  return nameOverride ? { content: rendered, nameOverride } : { content: rendered };
}
