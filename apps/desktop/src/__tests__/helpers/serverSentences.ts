// Test-only: reads the server's (and the shared package's) SOURCES as text and
// collects the English sentences a request can be answered with. Nothing here
// imports a server module (they open database clients).
//
// SHAPES READ
// - the message of `new X(…)` for every class that extends AppError, found by
//   reading the class declarations of apps/server/src (so a new subclass is
//   picked up): the site's literal, `+` chain, template, named top-level string
//   constant or `cond ? 'A' : 'B'`; a class that builds its own sentence
//   (`super('…')`, `super(\`${resource} not found\`)`) is read from its
//   constructor, and a constructor default (`message = '…'`) is a sentence too;
// - `error: …` values (res.json answers, socket acks) with the same operands;
// - the message of a `voice:error` / `dm:voice:error` emit;
// - `{ error }` shorthand inside `.json(…)`;
// - the pairs of the body-parser message table and the `|| '…'` fallback in
//   middleware/errorHandler.ts;
// - the `return '…';` sentences of packages/shared/src/validators.ts, including
//   `cond ? 'A' : 'B'` returns.
// Anything of those shapes whose value is NOT readable (a variable, a call, a
// longer conditional) is counted per file in `unseen`, never skipped.
//
// SHAPES IGNORED, ON PURPOSE
// - a plain `throw new Error('…')`, and the classes that extend Error (not
//   AppError: MailSuppressedError, SecretBoxUnavailableError,
//   SweepDeleteMismatchError, HygieneBatchFailedError): middleware/errorHandler.ts
//   answers anything that is not an AppError (or a body-parser/URI error) with
//   the fixed `Internal server error`, a sentence the scan reads there;
// - the `Error` messages of the socket handshake (`next(new Error('…'))` in
//   websocket/socketServer.ts): they do reach the client, which matches them
//   by their exact text to renew or end its session (services/socket.ts) and
//   shows none of them to a person;
// - the `message:` of a success answer (`{ success: true, message: '…' }`): a
//   confirmation, not a refusal; the desktop's screens word their own;
// - `res.send(…)`: no route uses one (every answer is `.json`, or an empty
//   `.end()` with a status);
// - `reason:` fields: the only literals are audit and log text, and the
//   `force:logout` reasons are shared constants the client maps by their
//   exact text;
// - `socket.emit('error', …)`: no server code emits one;
// - helpers that wrap an answer: none exist, every answer goes through the
//   error classes, `.json({ error })` or an ack.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export interface ServerSentence {
  /** The sentence as written; an expression inside a template is `${expr}`. */
  text: string;
  /** Repository-relative paths (forward slashes) that write it. */
  files: string[];
}

export interface ServerSentenceScan {
  sentences: ServerSentence[];
  /** Sites of a read shape whose sentence the scan could not read. Path -> count. */
  unseen: Record<string, number>;
}

const SKIP_DIRS = new Set(['__tests__', 'generated', 'node_modules', 'dist']);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) sourceFiles(full, out);
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

interface Read { texts: string[]; end: number }

/** Reads the '…', "…" or `…` literal that starts at `i`; one line only. */
function readLiteral(src: string, i: number): { text: string; end: number } | null {
  const quote = src[i];
  if (quote !== "'" && quote !== '"' && quote !== '`') return null;
  let j = i + 1;
  let text = '';
  while (j < src.length && src[j] !== quote) {
    const c = src[j];
    if (c === '\n') return null;
    if (c === '\\') {
      text += src[j + 1];
      j += 2;
    } else if (quote === '`' && c === '$' && src[j + 1] === '{') {
      let depth = 1;
      let k = j + 2;
      while (k < src.length && depth > 0) {
        if (src[k] === '{') depth++;
        else if (src[k] === '}') depth--;
        k++;
      }
      text += `\${${src.slice(j + 2, k - 1).trim()}}`;
      j = k;
    } else {
      text += c;
      j++;
    }
  }
  return j < src.length ? { text, end: j + 1 } : null;
}

const CONST_RE = /(?:^|\n)[ \t]*(?:export )?const ([A-Z][A-Z0-9_]+)\s*=\s*(?=['"`])/g;
const CONST_ARG_RE = /^([A-Z][A-Z0-9_]+)(?![\w.(])/;

function topLevelStringConstants(sources: string[]): Map<string, string> {
  const consts = new Map<string, string>();
  for (const src of sources) {
    for (const m of src.matchAll(CONST_RE)) {
      const lit = readLiteral(src, m.index + m[0].length);
      if (lit && /^\s*[;,]?\s*(\n|$)/.test(src.slice(lit.end, lit.end + 4))) consts.set(m[1], lit.text);
    }
  }
  return consts;
}

/** One operand: a literal chain joined by `+`, or a named top-level string constant. */
function readOperand(src: string, i: number, consts: Map<string, string>): { text: string; end: number } | null {
  const first = readLiteral(src, i);
  if (first) {
    let { text, end } = first;
    for (;;) {
      const plus = /^\s*\+\s*/.exec(src.slice(end, end + 40));
      if (!plus) break;
      const next = readLiteral(src, end + plus[0].length);
      if (!next) break;
      text += next.text;
      end = next.end;
    }
    return { text, end };
  }
  const named = CONST_ARG_RE.exec(src.slice(i, i + 80));
  if (named && consts.has(named[1])) return { text: consts.get(named[1])!, end: i + named[1].length };
  return null;
}

/**
 * The sentences a value can be: an operand, or `cond ? operand : operand`
 * (the condition is skipped over, on one statement). Null when not readable.
 * It must be followed by `,`, `)`, `}`, `;` or the end, so half a sentence of
 * a longer expression is never taken for the whole.
 */
function readValue(src: string, i: number, consts: Map<string, string>): Read | null {
  const direct = readOperand(src, i, consts);
  if (direct && /^\s*([,)};]|$)/.test(src.slice(direct.end, direct.end + 6))) return { texts: [direct.text], end: direct.end };
  const head = src.slice(i, i + 240);
  const q = /^[^;{}'"`?]*\?\s*/.exec(head);
  if (!q) return null;
  const a = readOperand(src, i + q[0].length, consts);
  if (!a) return null;
  const colon = /^\s*:\s*/.exec(src.slice(a.end, a.end + 40));
  if (!colon) return null;
  const b = readOperand(src, a.end + colon[0].length, consts);
  if (!b || !/^\s*([,)};]|$)/.test(src.slice(b.end, b.end + 6))) return null;
  return { texts: [a.text, b.text], end: b.end };
}

interface ErrorClass {
  name: string;
  parent: string;
  /** Name of the constructor's first parameter, when it is a plain one. */
  param: string | null;
  /** The constructor's default for that parameter, when it has one. */
  defaultText: string | null;
  /** The first argument of `super(…)`: a template, or a fixed sentence. */
  superText: string | null;
  superIsParam: boolean;
}

/** Reads every `class X extends Y` of the server and keeps those that reach AppError. */
function errorClasses(sources: string[], consts: Map<string, string>): Map<string, ErrorClass> {
  const all = new Map<string, ErrorClass>();
  for (const src of sources) {
    for (const m of src.matchAll(/\bclass (\w+) extends (\w+)\s*\{/g)) {
      const body = src.slice(m.index, m.index + 900);
      const next = body.indexOf('\nclass ', 10);
      const own = next === -1 ? body : body.slice(0, next);
      // the first constructor parameter: a plain one is the message, a property
      // parameter (`public readonly servers`) is not
      const ctor = /constructor\(\s*((?:(?:public|private|protected|readonly)\s+)*)(\w+)\s*(\??:\s*[\w<>[\]{}, ]+)?(=\s*)?/.exec(own);
      let param: string | null = null;
      let defaultText: string | null = null;
      if (ctor && ctor[1] === '') {
        param = ctor[2];
        if (ctor[4]) defaultText = readOperand(own, ctor.index + ctor[0].length, consts)?.text ?? null;
      }
      const sup = /\bsuper\(\s*/.exec(own);
      let superText: string | null = null;
      let superIsParam = false;
      if (sup) {
        const arg = readOperand(own, sup.index + sup[0].length, consts);
        if (arg) superText = arg.text;
        else if (param && new RegExp(`^${param}\\b`).test(own.slice(sup.index + sup[0].length))) superIsParam = true;
      }
      all.set(m[1], { name: m[1], parent: m[2], param, defaultText, superText, superIsParam });
    }
  }
  const keep = new Map<string, ErrorClass>();
  const reaches = (name: string, seen = new Set<string>()): boolean => {
    if (name === 'AppError') return true;
    const c = all.get(name);
    if (!c || seen.has(name)) return false;
    seen.add(name);
    return reaches(c.parent, seen);
  };
  for (const [name, c] of all) if (reaches(name)) keep.set(name, c);
  return keep;
}

/** The sentence an `AppError` subclass answers when its first argument is `site`. */
function classSentence(cls: Map<string, ErrorClass>, name: string, site: string): string {
  const c = cls.get(name);
  if (!c) return site;
  if (c.superIsParam || c.superText === null) return classSentence(cls, c.parent, site);
  if (c.param && c.superText.includes(`\${${c.param}}`)) return classSentence(cls, c.parent, c.superText.split(`\${${c.param}}`).join(site));
  return c.superText;
}

const ERROR_FIELD_RE = /\berror:\s*/g;
const VOICE_ERROR_RE = /'(?:dm:)?voice:error',\s*/g;
const JSON_CALL_RE = /\.json\(\s*\{/g;
const RETURN_RE = /\breturn\s+/g;
// a type position (`error: string;`), not an answer
const TYPE_VALUE_RE = /^(string|number|boolean|unknown|null|undefined|Error|any|void|never)\b/;

/** The text between the brace that opens at `open` and its match. */
function balanced(src: string, open: number): string {
  let depth = 0;
  for (let k = open; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}' && --depth === 0) return src.slice(open + 1, k);
  }
  return src.slice(open + 1);
}

/**
 * Collects the sentences written in `<root>/apps/server/src` and
 * `<root>/packages/shared/src` (see the header for what is read and what is
 * ignored on purpose).
 */
export function scanServerSentences(root: string): ServerSentenceScan {
  const paths = [
    ...sourceFiles(join(root, 'apps', 'server', 'src')),
    ...sourceFiles(join(root, 'packages', 'shared', 'src')),
  ];
  const texts = paths.map((p) => readFileSync(p, 'utf8'));
  const consts = topLevelStringConstants(texts);
  const classes = errorClasses(texts, consts);
  const throwRe = new RegExp(`new (${[...classes.keys()].join('|')})\\(\\s*`, 'g');
  const found = new Map<string, Set<string>>();
  const unseen: Record<string, number> = {};
  const add = (text: string, file: string) => {
    if (!found.has(text)) found.set(text, new Set());
    found.get(text)!.add(file);
  };
  const miss = (file: string) => {
    unseen[file] = (unseen[file] ?? 0) + 1;
  };

  paths.forEach((path, n) => {
    const src = texts[n];
    const file = relative(root, path).split(sep).join('/');

    // a class's own sentence: a fixed `super('…')` or a constructor default
    for (const [name, c] of classes) {
      if (!new RegExp(`\\bclass ${name} extends`).test(src)) continue;
      if (c.superText !== null && !(c.param && c.superText.includes(`\${${c.param}}`))) add(c.superText, file);
      if (c.defaultText !== null) add(c.defaultText, file);
    }

    for (const m of src.matchAll(throwRe)) {
      const at = m.index + m[0].length;
      if (src[at] === ')') continue; // no argument: the class's own sentence, read above
      const val = readValue(src, at, consts);
      const c = classes.get(m[1])!;
      if (!val) {
        // a class whose sentence is fixed ignores its argument (e.g. a list of spaces)
        if (c.param === null && c.superText !== null) continue;
        miss(file);
      } else {
        for (const text of val.texts) add(classSentence(classes, m[1], text), file);
      }
    }
    for (const m of src.matchAll(ERROR_FIELD_RE)) {
      const at = m.index + m[0].length;
      if (TYPE_VALUE_RE.test(src.slice(at, at + 12))) continue;
      const val = readValue(src, at, consts);
      if (val) for (const text of val.texts) add(text, file);
      else miss(file);
    }
    for (const m of src.matchAll(VOICE_ERROR_RE)) {
      const at = m.index + m[0].length;
      const obj = /^\{\s*message:\s*/.exec(src.slice(at, at + 40));
      const val = obj ? readValue(src, at + obj[0].length, consts) : null;
      if (val) for (const text of val.texts) add(text, file);
      else miss(file);
    }
    for (const m of src.matchAll(JSON_CALL_RE)) {
      const body = balanced(src, m.index + m[0].length - 1);
      if (/(^|[{,]\s*)error\s*(?=[,}]|$)/.test(body.replace(/\berror:[^,}]*/g, ''))) miss(file);
    }
    if (file.endsWith('middleware/errorHandler.ts')) {
      const table = /EXPOSED_ERROR_MESSAGES = new Map<[^(]*\(\[([\s\S]*?)\]\);/.exec(src);
      for (const m of (table?.[1] ?? '').matchAll(/\[\s*'[\w.]+',\s*(?=['"`])/g)) {
        const lit = readLiteral(table![1], m.index + m[0].length);
        if (lit) add(lit.text, file);
      }
      for (const m of src.matchAll(/\|\|\s*(?=['"`])/g)) {
        const lit = readLiteral(src, m.index + m[0].length);
        if (lit) add(lit.text, file);
      }
    }
    if (file === 'packages/shared/src/validators.ts') {
      for (const m of src.matchAll(RETURN_RE)) {
        const at = m.index + m[0].length;
        const val = readValue(src, at, consts);
        if (val) {
          for (const text of val.texts) if (/^[A-Z]/.test(text)) add(text, file);
        } else if (/^[`'"]/.test(src[at] ?? '') || /^[^;]*\?\s*[`'"]/.test(src.slice(at, at + 120))) {
          miss(file);
        }
      }
    }
  });

  const sentences = [...found].map(([text, files]) => ({ text, files: [...files].sort() }));
  sentences.sort((a, b) => a.text.localeCompare(b.text));
  return { sentences, unseen };
}
