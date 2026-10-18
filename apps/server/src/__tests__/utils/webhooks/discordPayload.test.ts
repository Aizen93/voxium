import { describe, it, expect } from 'vitest';
import { LIMITS } from '@voxium/shared';
import { renderDiscordPayload, formatEmbedTimestamp } from '../../../utils/webhooks/discordPayload';
import { bareLinkRuns, outsideCodeSpans } from './bareLinkRuns';

const BS = String.fromCharCode(0x5c); // one backslash
const DOT = String.fromCharCode(0xb7); // the footer separator's middle dot
const BR = '  \n'; // the line join inside an embed

function ok(body: unknown) {
  const result = renderDiscordPayload(body);
  if ('error' in result) throw new Error(`expected a rendered message, got error: ${result.error}`);
  return result;
}

function err(body: unknown): string {
  const result = renderDiscordPayload(body);
  if (!('error' in result)) throw new Error(`expected an error, got content: ${result.content}`);
  return result.error;
}

describe('renderDiscordPayload — body shape', () => {
  it('renders plain content as is', () => {
    expect(ok({ content: 'Deploy finished' })).toEqual({ content: 'Deploy finished' });
  });

  it('keeps markdown in content as the sender wrote it (like a human message)', () => {
    expect(ok({ content: '**bold** and `code`\nsecond line' }).content).toBe('**bold** and `code`\nsecond line');
  });

  it('strips HTML tags and trims, like sanitizeText does for humans', () => {
    expect(ok({ content: '  <b>hi</b> there <script>x</script> ' }).content).toBe('hi there x');
  });

  it.each([
    ['null', null],
    ['an array', [{ content: 'x' }]],
    ['a string', 'content'],
    ['a number', 42],
    ['undefined', undefined],
  ])('rejects a body that is %s', (_label, body) => {
    expect(err(body)).toBe('Body must be a JSON object');
  });

  it('rejects an empty object', () => {
    expect(err({})).toBe('content or embeds required');
  });

  it('rejects empty or whitespace-only content with no embeds', () => {
    expect(err({ content: '' })).toBe('content or embeds required');
    expect(err({ content: '   \n ' })).toBe('content or embeds required');
    expect(err({ content: '<p></p>' })).toBe('content or embeds required');
  });

  it('rejects content with only empty embeds', () => {
    expect(err({ embeds: [] })).toBe('content or embeds required');
    expect(err({ embeds: [{}, { color: 5 }, null, 'x'] })).toBe('content or embeds required');
  });

  it('treats non-string values as absent, never throws', () => {
    expect(err({ content: 42 })).toBe('content or embeds required');
    expect(err({ content: { text: 'x' }, embeds: 'nope' })).toBe('content or embeds required');
    expect(ok({ content: 'x', username: 7 })).toEqual({ content: 'x' });
    expect(ok({ embeds: [{ title: 5, description: 'd', author: 'a', footer: 'f', fields: 'x', url: 9, timestamp: 1 }] }).content)
      .toBe('> d');
    expect(ok({ embeds: [{ author: { name: 1 }, footer: { text: [] }, fields: [{ name: 1, value: 2 }, 'x', null], description: 'd' }] }).content)
      .toBe('> d');
  });

  it('rejects content over MESSAGE_MAX instead of truncating it', () => {
    expect(err({ content: 'a'.repeat(LIMITS.MESSAGE_MAX + 1) })).toBe(`Message must be at most ${LIMITS.MESSAGE_MAX} characters`);
    expect(ok({ content: 'a'.repeat(LIMITS.MESSAGE_MAX) }).content).toHaveLength(LIMITS.MESSAGE_MAX);
  });

  it('rejects when the flattened embeds push the content over MESSAGE_MAX', () => {
    const body = { content: 'a'.repeat(LIMITS.MESSAGE_MAX - 10), embeds: [{ description: 'b'.repeat(20) }] };
    expect(err(body)).toBe(`Message must be at most ${LIMITS.MESSAGE_MAX} characters`);
  });
});

describe('renderDiscordPayload — the input is bounded BEFORE any sanitising', () => {
  const TOO_LONG = `Message must be at most ${LIMITS.MESSAGE_MAX} characters`;

  it('rejects a 5,000-character content with the over-length error', () => {
    expect(err({ content: 'a'.repeat(5000) })).toBe(TOO_LONG);
  });

  it('rejects a single over-long field even when it would sanitise down to nothing', () => {
    // 4,001 characters of tags: the old path sanitised them to '' first and
    // answered "content or embeds required"; the bound now answers first
    expect(err({ content: '<>'.repeat(2001) })).toBe(TOO_LONG);
  });

  it.each([
    ['username', { content: 'x', username: 'u'.repeat(LIMITS.MESSAGE_MAX + 1) }],
    ['embed title', { embeds: [{ title: 't'.repeat(LIMITS.MESSAGE_MAX + 1) }] }],
    ['embed url', { embeds: [{ title: 't', url: `https://a.example/${'p'.repeat(LIMITS.MESSAGE_MAX)}` }] }],
    ['embed description', { embeds: [{ description: 'd'.repeat(LIMITS.MESSAGE_MAX + 1) }] }],
    ['embed author name', { embeds: [{ description: 'd', author: { name: 'a'.repeat(LIMITS.MESSAGE_MAX + 1) } }] }],
    ['embed footer text', { embeds: [{ description: 'd', footer: { text: 'f'.repeat(LIMITS.MESSAGE_MAX + 1) } }] }],
    ['embed timestamp', { embeds: [{ description: 'd', timestamp: ' '.repeat(LIMITS.MESSAGE_MAX + 1) }] }],
    ['field name', { embeds: [{ fields: [{ name: 'n'.repeat(LIMITS.MESSAGE_MAX + 1), value: 'v' }] }] }],
    ['field value', { embeds: [{ fields: [{ name: 'n', value: 'v'.repeat(LIMITS.MESSAGE_MAX + 1) }] }] }],
  ])('rejects an over-long %s', (_label, body) => {
    expect(err(body)).toBe(TOO_LONG);
  });

  it('rejects a 2,500 + 2,500 split across content and an embed (each under the cap)', () => {
    expect(err({ content: 'a'.repeat(2500), embeds: [{ description: 'b'.repeat(2500) }] })).toBe(TOO_LONG);
  });

  it('rejects a summed length over MESSAGE_MAX * 2 even when each field is short', () => {
    const fields = Array.from({ length: LIMITS.WEBHOOK_EMBED_FIELDS_MAX }, () => ({ name: 'n', value: '<i></i>'.repeat(50) }));
    const embeds = Array.from({ length: 3 }, () => ({ fields }));
    // 3 x 25 x 351 = 26,325 characters that would all sanitise away
    expect(err({ content: 'x', embeds })).toBe(TOO_LONG);
  });

  it('a summed length of exactly MESSAGE_MAX * 2 is not refused by the bound', () => {
    const half = LIMITS.MESSAGE_MAX;
    // 4,000 + 4,000 characters of which only "ok" and one embed line render
    const body = { content: `ok${'<>'.repeat((half - 2) / 2)}`, embeds: [{ description: `d${'<>'.repeat((half - 2) / 2)}x` }] };
    expect(ok(body).content).toBe('ok\n\n> dx');
  });

  it('a 3,900-character content with a short embed still renders as before', () => {
    const content = 'a'.repeat(3900);
    expect(ok({ content, embeds: [{ title: 'Alert', description: 'all good' }] }).content)
      .toBe(`${content}\n\n> **Alert**${BR}> all good`);
  });

  it('ignores the length of fields the renderer never reads', () => {
    expect(ok({ content: 'x', avatar_url: 'p'.repeat(20_000), pad: 'p'.repeat(20_000), embeds: [{ description: 'd', image: { url: 'i'.repeat(20_000) } }] }).content)
      .toBe('x\n\n> d');
  });

  it('a non-string field counts for nothing (it is ignored, never measured)', () => {
    expect(ok({ content: 'x', username: 12345, embeds: [{ title: { length: 1e9 }, description: 'd' }] }).content).toBe('x\n\n> d');
  });
});

describe('renderDiscordPayload — username', () => {
  it('returns a sanitised username as nameOverride', () => {
    expect(ok({ content: 'x', username: '  <b>Uptime</b> Kuma ' })).toEqual({ content: 'x', nameOverride: 'Uptime Kuma' });
  });

  it('collapses line breaks in the username', () => {
    expect(ok({ content: 'x', username: 'Line\none' }).nameOverride).toBe('Line one');
  });

  it('keeps exactly WEBHOOK_NAME_MAX characters and TRUNCATES a longer username (never an error)', () => {
    const max = LIMITS.WEBHOOK_NAME_MAX;
    expect(ok({ content: 'x', username: 'n'.repeat(max) }).nameOverride).toBe('n'.repeat(max));
    // Discord accepts 80: a Discord notifier's name must not fail the delivery
    expect(ok({ content: 'x', username: 'n'.repeat(max + 1) })).toEqual({ content: 'x', nameOverride: 'n'.repeat(max) });
    expect(ok({ content: 'x', username: 'm'.repeat(80) }).nameOverride).toBe('m'.repeat(max));
  });

  it('truncates AFTER sanitising and collapsing line breaks, then trims the cut', () => {
    const max = LIMITS.WEBHOOK_NAME_MAX;
    const name = `<b>${'a'.repeat(max - 2)}</b>\n\n${'z'.repeat(20)}`;
    // tags gone, the line breaks become ONE space at index max - 2, cut at max
    expect(ok({ content: 'x', username: name }).nameOverride).toBe(`${'a'.repeat(max - 2)} z`);
    // a cut that lands right after a space does not leave it trailing
    expect(ok({ content: 'x', username: `${'a'.repeat(max - 1)} tail` }).nameOverride).toBe('a'.repeat(max - 1));
  });

  it('never splits a surrogate pair at the cut', () => {
    const max = LIMITS.WEBHOOK_NAME_MAX;
    const emoji = String.fromCodePoint(0x1f680);
    const name = ok({ content: 'x', username: `${'a'.repeat(max - 1)}${emoji}${emoji}` }).nameOverride as string;
    expect(name).toBe('a'.repeat(max - 1));
    const last = name.charCodeAt(name.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
  });

  it('measures the length AFTER sanitising and trimming', () => {
    const max = LIMITS.WEBHOOK_NAME_MAX;
    expect(ok({ content: 'x', username: `  ${'n'.repeat(max)}  <i></i>` }).nameOverride).toBe('n'.repeat(max));
  });

  it('a username that sanitises to nothing is no override', () => {
    expect(ok({ content: 'x', username: '   ' })).toEqual({ content: 'x' });
    expect(ok({ content: 'x', username: '<img src=x>' })).toEqual({ content: 'x' });
  });
});

describe('renderDiscordPayload — embeds', () => {
  const richEmbed = {
    author: { name: 'CI Bot', url: 'https://ignored.example', icon_url: 'https://ignored.example/i.png' },
    title: 'Build #42',
    url: 'https://ci.example.com/42',
    description: 'All green',
    fields: [
      { name: 'Branch', value: 'main', inline: true },
      { name: 'Duration', value: '3m' },
    ],
    footer: { text: 'ci.example.com', icon_url: 'https://ignored.example/f.png' },
    timestamp: '2026-10-17T09:58:30Z',
    color: 3066993,
  };

  it('flattens one rich embed exactly as laid out', () => {
    expect(ok({ content: 'Deploy finished', embeds: [richEmbed] }).content).toBe(
      'Deploy finished\n\n'
      + `> _CI Bot_${BR}`
      + `> **[Build ${BS}#42](https://ci.example.com/42)**${BR}`
      + `> All green${BR}`
      + `> **Branch**: main${BR}`
      + `> **Duration**: 3m${BR}`
      + `> _ci.example.com ${DOT} 2026-10-17 09:58_`,
    );
  });

  it('renders embeds without content, one blockquote each, separated by a blank line', () => {
    expect(ok({ embeds: [{ title: 'One' }, { title: 'Two', description: 'second' }] }).content)
      .toBe(`> **One**\n\n> **Two**${BR}> second`);
  });

  it('skips embeds that render nothing, and non-object embeds', () => {
    expect(ok({ embeds: [{}, null, 3, { title: 'Only' }] }).content).toBe('> **Only**');
  });

  it('omits absent lines', () => {
    expect(ok({ embeds: [{ description: 'just a description' }] }).content).toBe('> just a description');
    expect(ok({ embeds: [{ footer: { text: 'footer only' } }] }).content).toBe('> _footer only_');
    expect(ok({ embeds: [{ timestamp: '2026-10-17T09:58:00Z' }] }).content).toBe('> _2026-10-17 09:58_');
    expect(ok({ embeds: [{ author: { name: 'Author' } }] }).content).toBe('> _Author_');
  });

  it('prefixes every line of a multi-line description so it stays in the blockquote', () => {
    expect(ok({ embeds: [{ title: 'T', description: 'line one\nline two\r\n\nline four' }] }).content)
      .toBe(`> **T**${BR}> line one${BR}> line two${BR}>${BR}> line four`);
  });

  it('prefixes every line of a multi-line field value too', () => {
    expect(ok({ embeds: [{ fields: [{ name: 'Log', value: 'first\nsecond' }] }] }).content)
      .toBe(`> **Log**: first${BR}> second`);
  });

  it('renders a field with only a name or only a value, and skips an empty field', () => {
    expect(ok({ embeds: [{ fields: [{ name: 'Name only' }, { value: 'value only' }, { name: '', value: '' }, {}] }] }).content)
      .toBe(`> **Name only**${BR}> value only`);
  });

  it('drops the link and keeps the title when url is missing or not http(s)', () => {
    expect(ok({ embeds: [{ title: 'No url' }] }).content).toBe('> **No url**');
    expect(ok({ embeds: [{ title: 'Bad', url: 'javascript:alert(1)' }] }).content).toBe('> **Bad**');
    expect(ok({ embeds: [{ title: 'Data', url: 'data:text/html,hi' }] }).content).toBe('> **Data**');
    expect(ok({ embeds: [{ title: 'Garbage', url: 'not a url' }] }).content).toBe('> **Garbage**');
  });

  it('keeps http links as well as https', () => {
    expect(ok({ embeds: [{ title: 'Plain', url: 'http://status.example.org/' }] }).content)
      .toBe('> **[Plain](http://status.example.org/)**');
  });

  it('a url with a ) cannot end the destination early', () => {
    expect(ok({ embeds: [{ title: 'Wiki', url: 'https://en.example.org/wiki/Foo_(bar)' }] }).content)
      .toBe(`> **[Wiki](https://en.example.org/wiki/Foo_${BS}(bar${BS}))**`);
  });

  it('escapes a title containing ](https://evil) so it cannot close the link', () => {
    const content = ok({ embeds: [{ title: 'Click](https://evil.example)', url: 'https://good.example/' }] }).content;
    expect(content).toBe(`> **[Click${BS}]${BS}(https://evil.example${BS})](https://good.example/)**`);
    // the only unescaped "](" is the formatter's own
    expect(content.match(/(?<!\\)\]\(/g)).toHaveLength(1);
  });

  it('escapes author names, field names and footer text, but not description or field values', () => {
    const content = ok({
      embeds: [{
        author: { name: '_under_ *star*' },
        description: '**kept** _as written_',
        fields: [{ name: 'a|b', value: '`code` stays' }],
        footer: { text: '# not a heading' },
      }],
    }).content;
    expect(content).toBe(
      `> _${BS}_under${BS}_ ${BS}*star${BS}*_${BR}`
      + `> **kept** _as written_${BR}`
      + `> **a${BS}|b**: \`code\` stays${BR}`
      + `> _${BS}# not a heading_`,
    );
  });

  it('collapses newlines in single-line fields (title, author, field name, footer)', () => {
    const content = ok({
      embeds: [{ author: { name: 'A\nB' }, title: 'T\nU', fields: [{ name: 'N\r\nM', value: 'v' }], footer: { text: 'F\nG' } }],
    }).content;
    expect(content).toBe(`> _A B_${BR}> **T U**${BR}> **N M**: v${BR}> _F G_`);
  });

  it('accepts WEBHOOK_EMBEDS_MAX embeds and rejects one more', () => {
    const max = LIMITS.WEBHOOK_EMBEDS_MAX;
    const embeds = Array.from({ length: max }, (_, i) => ({ title: `E${i}` }));
    expect(ok({ embeds }).content.split('\n\n')).toHaveLength(max);
    expect(err({ embeds: [...embeds, { title: 'one too many' }] })).toBe(`embeds must contain at most ${max} items`);
  });

  it('accepts WEBHOOK_EMBED_FIELDS_MAX fields and rejects one more', () => {
    const max = LIMITS.WEBHOOK_EMBED_FIELDS_MAX;
    const fields = Array.from({ length: max }, (_, i) => ({ name: `f${i}`, value: 'v' }));
    expect(ok({ embeds: [{ fields }] }).content.split(BR)).toHaveLength(max);
    expect(err({ embeds: [{ fields: [...fields, { name: 'x', value: 'y' }] }] }))
      .toBe(`embed fields must contain at most ${max} items`);
  });

  it('checks the field cap on every embed, not only the first', () => {
    const fields = Array.from({ length: LIMITS.WEBHOOK_EMBED_FIELDS_MAX + 1 }, () => ({ name: 'n', value: 'v' }));
    expect(err({ embeds: [{ title: 'fine' }, { fields }] })).toBe(`embed fields must contain at most ${LIMITS.WEBHOOK_EMBED_FIELDS_MAX} items`);
  });

  it('ignores every unsupported top-level and embed field without error', () => {
    const body = {
      content: 'hello',
      avatar_url: 'https://tracker.example/pixel.png',
      tts: true,
      allowed_mentions: { parse: ['everyone'] },
      flags: 4096,
      thread_name: 'thread',
      components: [{ type: 1 }],
      attachments: [{ id: 1 }],
      files: ['x'],
      poll: { question: { text: 'q' } },
      embeds: [{
        title: 'T',
        color: 16711680,
        image: { url: 'https://tracker.example/image.png' },
        thumbnail: { url: 'https://tracker.example/thumb.png' },
        video: { url: 'https://tracker.example/video.mp4' },
        provider: { name: 'Provider', url: 'https://tracker.example' },
        author: { name: 'A', url: 'https://tracker.example/a', icon_url: 'https://tracker.example/a.png' },
        footer: { text: 'F', icon_url: 'https://tracker.example/f.png' },
        fields: [{ name: 'N', value: 'V', inline: true }],
      }],
    };
    const result = ok(body);
    expect(result).toEqual({ content: `hello\n\n> _A_${BR}> **T**${BR}> **N**: V${BR}> _F_` });
    // nothing a reader's client could fetch survives
    expect(result.content).not.toContain('tracker.example');
  });

  it('does not turn @[userId] into anything (mentions are never resolved for webhooks)', () => {
    expect(ok({ content: 'hey @[user-123]' }).content).toBe('hey @[user-123]');
  });
});

describe('renderDiscordPayload — runs remark-gfm would autolink by itself', () => {
  it('puts every address in a single-line field in a code span: a title without url, the author, field names, the footer', () => {
    const content = ok({
      embeds: [{
        author: { name: 'ops@evil.example' },
        title: 'Down: https://evil.example/login',
        fields: [{ name: 'www.evil.example' }, { name: 'Mirror HTTP://EVIL.EXAMPLE/x.' }],
        footer: { text: 'via https://evil.example/a_(b)' },
      }],
    }).content;
    expect(content).toBe(
      `> _\`ops@evil.example\`_${BR}`
      + `> **Down: \`https://evil.example/login\`**${BR}`
      + `> **\`www.evil.example\`**${BR}`
      + `> **Mirror \`HTTP://EVIL.EXAMPLE/x\`.**${BR}`
      + `> _via \`https://evil.example/a_(b)\`_`,
    );
    expect(bareLinkRuns(content)).toEqual([]);
  });

  it('keeps an address verbatim in its span: no backslash lands inside it, a backtick is replaced', () => {
    const content = ok({ embeds: [{ title: 'See https://ci.example/run#12_a*b and x_y@ci.example`z' }] }).content;
    expect(content).toBe(`> **See \`https://ci.example/run#12_a*b\` and \`x_y@ci.example\`${BS}\`z**`);
    expect(bareLinkRuns(content)).toEqual([]);
  });

  it('unwraps a Discord <https://...> in a single-line field into a code span too', () => {
    expect(ok({ embeds: [{ footer: { text: 'status <https://status.example.com/7>' } }] }).content)
      .toBe('> _status `https://status.example.com/7`_');
  });

  it('a title WITH a url is a link label: GFM never autolinks inside a link, so its text is only escaped', () => {
    expect(ok({ embeds: [{ title: 'Build https://ci.example/42', url: 'https://ci.example/42' }] }).content)
      .toBe('> **[Build https://ci.example/42](https://ci.example/42)**');
  });

  it('leaves a bare URL in content, a description and a field value as the sender wrote it (free text)', () => {
    const content = ok({
      content: 'Incident at https://status.example.com/incident/7',
      embeds: [{ description: 'Details at https://status.example.com/d and ops@status.example', fields: [{ name: 'Runbook', value: 'www.status.example/rb' }] }],
    }).content;
    expect(content).toBe(
      'Incident at https://status.example.com/incident/7\n\n'
      + `> Details at https://status.example.com/d and ops@status.example${BR}`
      + '> **Runbook**: www.status.example/rb',
    );
  });
});

describe('renderDiscordPayload — single-line fields keep their characters', () => {
  it('writes < > & in a title, the author, a field name and the footer as entities: shown as typed, nothing stripped', () => {
    const content = ok({
      embeds: [{
        title: 'Option<T> for a<b and c>d',
        url: 'https://ci.example/1',
        author: { name: '<b>CI</b>' },
        fields: [{ name: 'R&D', value: 'v' }],
        footer: { text: 'CPU > 90% on <host>' },
      }],
    }).content;
    expect(content).toBe(
      `> _&lt;b&gt;CI&lt;/b&gt;_${BR}`
      + `> **[Option&lt;T&gt; for a&lt;b and c&gt;d](https://ci.example/1)**${BR}`
      + `> **R&amp;D**: v${BR}`
      + '> _CPU &gt; 90% on &lt;host&gt;_',
    );
    expect(outsideCodeSpans(content.replace(/^> /gm, ''))).not.toMatch(/[<>]/);
  });

  it('a title typed with entities shows them as typed (the & is encoded first)', () => {
    expect(ok({ embeds: [{ title: '&lt;b&gt; &amp;' }] }).content).toBe('> **&amp;lt;b&amp;gt; &amp;amp;**');
  });

  it('a single-line field made only of a tag is no longer stripped to nothing', () => {
    expect(ok({ embeds: [{ title: '<p></p>' }] }).content).toBe('> **&lt;p&gt;&lt;/p&gt;**');
  });
});

describe('renderDiscordPayload — Discord angle-bracket autolinks', () => {
  it('unwraps <https://...> and <http://...> instead of letting sanitizeText eat them', () => {
    expect(ok({ content: 'see <https://status.example.com/incident/7> now' }).content)
      .toBe('see https://status.example.com/incident/7 now');
    expect(ok({ content: '<http://a.example/x?y=1>' }).content).toBe('http://a.example/x?y=1');
  });

  it('unwraps them in descriptions and field values too', () => {
    expect(ok({ embeds: [{ description: 'at <https://a.example/d>', fields: [{ name: 'Link', value: '<https://a.example/f>' }] }] }).content)
      .toBe(`> at https://a.example/d${BR}> **Link**: https://a.example/f`);
  });

  it('still strips real tags and non-http angle brackets', () => {
    expect(ok({ content: 'a <javascript:alert(1)> b <b>c</b>' }).content).toBe('a  b c');
  });
});

describe('renderDiscordPayload — a lone < cannot eat the layout', () => {
  it('leaves a lone < in content-only messages exactly as a human message would', () => {
    expect(ok({ content: 'latency < 200ms' }).content).toBe('latency < 200ms');
  });

  it('encodes a lone < as &lt; when it would otherwise swallow embed markup', () => {
    const content = ok({ content: 'value < threshold', embeds: [{ title: 'Alert', description: 'a < b', fields: [{ name: 'F', value: 'v' }] }] }).content;
    expect(content).toBe(`value &lt; threshold\n\n> **Alert**${BR}> a &lt; b${BR}> **F**: v`);
  });
});

describe('formatEmbedTimestamp', () => {
  it('formats an ISO timestamp as YYYY-MM-DD HH:mm in UTC', () => {
    expect(formatEmbedTimestamp('2026-10-17T09:58:30Z')).toBe('2026-10-17 09:58');
    expect(formatEmbedTimestamp('2026-10-17T09:58:30.123456Z')).toBe('2026-10-17 09:58');
    expect(formatEmbedTimestamp('2026-10-17T09:58:30+02:00')).toBe('2026-10-17 07:58');
    expect(formatEmbedTimestamp('2026-10-17T09:58:30-0130')).toBe('2026-10-17 11:28');
    expect(formatEmbedTimestamp('2026-10-17 09:58:30z')).toBe('2026-10-17 09:58');
    expect(formatEmbedTimestamp('2026-10-17')).toBe('2026-10-17 00:00');
  });

  it('reads a date-time without an offset as UTC, whatever the server time zone', () => {
    expect(formatEmbedTimestamp('2026-10-17T09:58')).toBe('2026-10-17 09:58');
    expect(formatEmbedTimestamp('2026-10-17T23:59:59')).toBe('2026-10-17 23:59');
  });

  it('returns empty for invalid timestamps', () => {
    for (const bad of ['', 'yesterday', 'October 17, 2026', '2026-13-01T00:00:00Z', '2026-02-31T00:00:00Z', '2026-10-17T25:00:00Z', '17/10/2026', 1760695080000, null, {}]) {
      expect(formatEmbedTimestamp(bad)).toBe('');
    }
  });

  it('an invalid timestamp is omitted from the footer, the footer text stays', () => {
    expect(ok({ embeds: [{ footer: { text: 'F' }, timestamp: 'not a date' }] }).content).toBe('> _F_');
    expect(err({ embeds: [{ timestamp: 'not a date' }] })).toBe('content or embeds required');
  });
});
