import { describe, it, expect } from 'vitest';
import {
  collapseLineBreaks,
  encodeHtmlEntities,
  escapeLinkDestination,
  escapeMarkdown,
  neutraliseAutolinks,
  safeHttpUrl,
} from '../../../utils/webhooks/markdown';
import { bareLinkRuns } from './bareLinkRuns';

const BS = String.fromCharCode(0x5c); // a single backslash, spelled out
const chr = (cp: number) => String.fromCharCode(cp);

describe('escapeMarkdown', () => {
  it.each(['\\', '*', '_', '~', '`', '[', ']', '(', ')', '#', '>', '|'])('backslash-escapes %s', (ch) => {
    expect(escapeMarkdown(`a${ch}b`)).toBe(`a${BS}${ch}b`);
  });

  it('escapes the backslash itself exactly once (no double processing)', () => {
    expect(escapeMarkdown(`${BS}*`)).toBe(`${BS}${BS}${BS}*`);
  });

  it('leaves ordinary text and other punctuation alone', () => {
    expect(escapeMarkdown('Build 42 passed: ok! (no) - yes.')).toBe(`Build 42 passed: ok! ${BS}(no${BS}) - yes.`);
    expect(escapeMarkdown('plain words, 100% fine & dandy')).toBe('plain words, 100% fine & dandy');
  });

  it('a title containing ](https://evil) cannot close a link early', () => {
    const escaped = escapeMarkdown('Click](https://evil.example)');
    expect(escaped).toBe(`Click${BS}]${BS}(https://evil.example${BS})`);
    // Inside a link, every bracket/paren the sender wrote is escaped: the only
    // unescaped "](" left is the one the formatter adds
    const link = `[${escaped}](https://good.example)`;
    const unescapedCloses = link.match(/(?<!\\)\]\(/g) ?? [];
    expect(unescapedCloses).toHaveLength(1);
  });

  it('collapses CR, LF and CRLF runs into one space', () => {
    expect(escapeMarkdown('line one\nline two')).toBe('line one line two');
    expect(escapeMarkdown('a\r\nb')).toBe('a b');
    expect(escapeMarkdown('a\rb')).toBe('a b');
    expect(escapeMarkdown('a\n\n\r\nb')).toBe('a b');
  });

  it('collapses the other line separators too (VT, FF, NEL, U+2028, U+2029)', () => {
    for (const cp of [0x0b, 0x0c, 0x85, 0x2028, 0x2029]) {
      expect(escapeMarkdown(`a${chr(cp)}b`)).toBe('a b');
    }
  });

  it('a newline cannot start a new markdown block (heading, quote, list)', () => {
    const escaped = escapeMarkdown('title\n# heading\n> quote');
    expect(escaped).not.toMatch(/[\r\n]/);
    expect(escaped).toBe(`title ${BS}# heading ${BS}> quote`);
  });
});

describe('collapseLineBreaks', () => {
  it('turns each run of line breaks into one space and leaves the rest', () => {
    expect(collapseLineBreaks(`a\r\n\nb${chr(0x2028)}c`)).toBe('a b c');
    expect(collapseLineBreaks('no breaks *here*')).toBe('no breaks *here*');
  });
});

describe('encodeHtmlEntities', () => {
  it('writes &, < and > as entities, the & first (an entity typed by the sender stays literal)', () => {
    expect(encodeHtmlEntities('a<b && c>d')).toBe('a&lt;b &amp;&amp; c&gt;d');
    expect(encodeHtmlEntities('&lt;b&gt;')).toBe('&amp;lt;b&amp;gt;');
    expect(encodeHtmlEntities('plain')).toBe('plain');
  });
});

describe('neutraliseAutolinks', () => {
  it.each([
    ['https://evil.example/login', '`https://evil.example/login`'],
    ['http://evil.example', '`http://evil.example`'],
    ['HTTPS://EVIL.EXAMPLE', '`HTTPS://EVIL.EXAMPLE`'],
    ['www.evil.example', '`www.evil.example`'],
    ['(www.evil.example)', `${BS}(\`www.evil.example\`${BS})`],
    ['_www.evil.example', `${BS}_\`www.evil.example\``],
    ['x@evil.example', '`x@evil.example`'],
    ['mailto:x@evil.example', 'mailto:`x@evil.example`'],
    ['x_y.z+tag@mail.evil-host.example', '`x_y.z+tag@mail.evil-host.example`'],
  ])('wraps %s in a code span', (input, expected) => {
    expect(neutraliseAutolinks(input)).toBe(expected);
  });

  it('escapes the text around the runs, never inside them (a URL reads verbatim)', () => {
    expect(neutraliseAutolinks('*see* https://github.com/a/b/issues/12#issuecomment-1_x [now]'))
      .toBe(`${BS}*see${BS}* \`https://github.com/a/b/issues/12#issuecomment-1_x\` ${BS}[now${BS}]`);
  });

  it('applies the given escape to the text around the runs', () => {
    expect(neutraliseAutolinks('a<b https://x.example c>d', (part) => part.toUpperCase())).toBe('A<B `https://x.example` C>D');
  });

  it('replaces a backtick inside a run (it would end the span), and a run ends at one', () => {
    expect(neutraliseAutolinks('x@evil.example`y')).toBe(`\`x@evil.example\`${BS}\`y`);
    expect(neutraliseAutolinks('https://evil.example/a`b')).toBe(`\`https://evil.example/a\`${BS}\`b`);
  });

  it('ends a URL run at whitespace or an angle bracket, which never sit raw in a span', () => {
    expect(neutraliseAutolinks('https://a.example<b>c https://d.example>e', encodeHtmlEntities))
      .toBe('`https://a.example`&lt;b&gt;c `https://d.example`&gt;e');
  });

  it('keeps trailing punctuation and an unmatched ) out of the span, a balanced ) in it', () => {
    expect(neutraliseAutolinks('https://a.example/x.')).toBe('`https://a.example/x`.');
    expect(neutraliseAutolinks('https://a.example/x),')).toBe(`\`https://a.example/x\`${BS}),`);
    expect(neutraliseAutolinks('https://a.example/Foo_(bar)')).toBe('`https://a.example/Foo_(bar)`');
    expect(neutraliseAutolinks('www.a.example!?')).toBe('`www.a.example`!?');
  });

  it('leaves text without an address alone apart from the escape, and does not wrap look-alikes', () => {
    expect(neutraliseAutolinks('a.example and ftp-ish stuff, awww.x')).toBe('a.example and ftp-ish stuff, awww.x');
    expect(neutraliseAutolinks('no @ here, and @[user-1]')).toBe(`no @ here, and @${BS}[user-1${BS}]`);
  });

  it('collapses line breaks first, so a run never spans two lines', () => {
    expect(neutraliseAutolinks('see\nhttps://a.example')).toBe('see `https://a.example`');
  });

  it('wraps several runs and leaves nothing autolinkable outside a span', () => {
    const out = neutraliseAutolinks('https://a.example then www.b.example then c@d.example, end');
    expect(out).toBe('`https://a.example` then `www.b.example` then `c@d.example`, end');
    expect(bareLinkRuns(out)).toEqual([]);
  });

  /** The fastest of `rounds` timings of one call, each round averaged over `batch` calls. */
  function fastestPerCallMs(text: string, batch: number, rounds = 5): number {
    neutraliseAutolinks(text); // warm-up: the first call also pays for compilation
    let fastest = Infinity;
    for (let round = 0; round < rounds; round++) {
      const started = performance.now();
      for (let i = 0; i < batch; i++) neutraliseAutolinks(text);
      fastest = Math.min(fastest, (performance.now() - started) / batch);
    }
    return fastest;
  }

  // A growth ratio, not a wall-clock bound: a slow or busy runner slows both
  // sizes alike, so only how the cost grows is compared. Ten times the input
  // costs about ten times the time when the scan is linear and about a
  // hundred times when it backtracks quadratically; 30x sits between them
  // with margin on both sides. Each timing is the fastest round (GC pauses and
  // other workers only ever add time), and the short input is timed over a
  // batch of calls so the timer's resolution cannot dominate it.
  it.each([
    ['a long run of address characters without an @', (n: number) => 'a'.repeat(n)],
    ['a URL followed by a long run of closing parentheses', (n: number) => `https://${')'.repeat(n)}`],
  ])('stays linear on %s', (_label, input) => {
    const small = fastestPerCallMs(input(20_000), 10);
    const large = fastestPerCallMs(input(200_000), 1);
    expect(large).toBeLessThan(small * 30);
    // a sanity ceiling only: a hang still fails, a slow runner does not
    expect(large).toBeLessThan(5000);
  });
});

describe('safeHttpUrl', () => {
  it('accepts https and http URLs (normalised href)', () => {
    expect(safeHttpUrl('https://ci.example.com/42')).toBe('https://ci.example.com/42');
    expect(safeHttpUrl('http://status.example.org/page?x=1#y')).toBe('http://status.example.org/page?x=1#y');
    expect(safeHttpUrl('HTTPS://Example.COM')).toBe('https://example.com/');
  });

  it('rejects javascript: and data: URLs', () => {
    expect(safeHttpUrl('javascript:alert(1)')).toBeNull();
    expect(safeHttpUrl('JavaScript:alert(1)')).toBeNull();
    expect(safeHttpUrl('data:text/html,<script>alert(1)</script>')).toBeNull();
  });

  it('rejects other schemes', () => {
    expect(safeHttpUrl('ftp://example.com/file')).toBeNull();
    expect(safeHttpUrl('file:///etc/passwd')).toBeNull();
    expect(safeHttpUrl('mailto:someone@example.com')).toBeNull();
    expect(safeHttpUrl('vbscript:msgbox')).toBeNull();
  });

  it('rejects garbage, relative paths and non-strings', () => {
    expect(safeHttpUrl('not a url')).toBeNull();
    expect(safeHttpUrl('/relative/path')).toBeNull();
    expect(safeHttpUrl('')).toBeNull();
    expect(safeHttpUrl(undefined)).toBeNull();
    expect(safeHttpUrl(null)).toBeNull();
    expect(safeHttpUrl(42)).toBeNull();
    expect(safeHttpUrl({ href: 'https://example.com' })).toBeNull();
  });

  it('normalises away newlines, spaces and angle brackets (they cannot reach a link destination)', () => {
    const href = safeHttpUrl('https://example.com/a\nb c<d>');
    expect(href).toBe('https://example.com/ab%20c%3Cd%3E');
  });
});

describe('escapeLinkDestination', () => {
  it('escapes parentheses and backslashes so a ) in the URL cannot end the destination', () => {
    expect(escapeLinkDestination('https://en.example.org/wiki/Foo_(bar)')).toBe(`https://en.example.org/wiki/Foo_${BS}(bar${BS})`);
    expect(escapeLinkDestination(`https://example.com/?q=${BS}`)).toBe(`https://example.com/?q=${BS}${BS}`);
  });

  it('an injected second link stays inside the first destination', () => {
    const href = safeHttpUrl('https://good.example/x)[click](javascript:alert(1)')!;
    const dest = escapeLinkDestination(href);
    expect(dest.match(/(?<!\\)[()]/g)).toBeNull();
  });

  it('leaves an ordinary URL unchanged', () => {
    expect(escapeLinkDestination('https://ci.example.com/42?a=1&b=2#c')).toBe('https://ci.example.com/42?a=1&b=2#c');
  });
});
