/**
 * Finds catch handlers that hold nothing. Pure and linear: comments are
 * dropped and string, template and regular-expression contents blanked
 * first, so a pattern written inside a string or a comment is never counted,
 * then the stripped text is walked once by hand (no backtracking regex).
 *
 * Counted: a `catch` block (with or without a binding, on one line or many)
 * whose body is empty or holds only comments, and an arrow handed to
 * `.catch(...)` whose body is empty, `undefined`, `null` or `void 0`.
 * Not counted: `.catch(identifier)` and a catch that only returns or
 * continues.
 */

const isIdentChar = (c: string | undefined) => c !== undefined && /[\w$]/.test(c);
const isSpace = (c: string | undefined) => c !== undefined && /\s/.test(c);

/** Source with comments removed and literal contents blanked (braces kept). */
export function stripCommentsAndLiterals(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  // one entry per open template expression: the brace depth inside it
  const templates: number[] = [];
  let lastSignificant = '';
  const regexAllowed = () => lastSignificant === '' || '(,=:[!&|?{};+-*%<>~^'.includes(lastSignificant);

  // i is just after an opening backtick, or just after the `}` closing an expression
  const readTemplate = () => {
    out += '`';
    while (i < n) {
      const c = src[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { out += '`'; i++; lastSignificant = '`'; return; }
      if (c === '$' && src[i + 1] === '{') { templates.push(0); out += '${'; i += 2; lastSignificant = '{'; return; }
      i++;
    }
  };

  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      out += ' ';
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      while (i < n && src[i] !== c && src[i] !== '\n') { if (src[i] === '\\') i++; i++; }
      i++;
      out += c + c;
      lastSignificant = c;
      continue;
    }
    if (c === '`') { i++; readTemplate(); continue; }
    if (c === '/' && regexAllowed()) {
      i++;
      let inClass = false;
      while (i < n && src[i] !== '\n') {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        else if (src[i] === '/' && !inClass) break;
        i++;
      }
      i++;
      while (isIdentChar(src[i])) i++;
      out += '/ /';
      lastSignificant = '/';
      continue;
    }
    if (templates.length > 0) {
      if (c === '{') templates[templates.length - 1]++;
      else if (c === '}') {
        if (templates[templates.length - 1] === 0) { templates.pop(); out += '}'; i++; readTemplate(); continue; }
        templates[templates.length - 1]--;
      }
    }
    out += c;
    if (!isSpace(c)) lastSignificant = c;
    i++;
  }
  return out;
}

function skipSpaces(s: string, i: number): number {
  while (i < s.length && isSpace(s[i])) i++;
  return i;
}

/** Index just past the bracket that closes the one at `open`, or -1. */
function matching(s: string, open: number): number {
  const pairs: Record<string, string> = { '(': ')', '{': '}', '[': ']' };
  const stack: string[] = [];
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === ')' || c === '}' || c === ']') {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return i + 1;
    }
  }
  return -1;
}

function startsWord(s: string, i: number, word: string): boolean {
  return s.startsWith(word, i) && !isIdentChar(s[i + word.length]);
}

/** Offsets (in the stripped text) of every silent catch handler. */
export function findSilentCatches(source: string): number[] {
  const s = stripCommentsAndLiterals(source);
  const found: number[] = [];
  for (let at = s.indexOf('catch'); at !== -1; at = s.indexOf('catch', at + 1)) {
    if (isIdentChar(s[at - 1]) || isIdentChar(s[at + 5])) continue;
    let i = skipSpaces(s, at + 5);
    if (s[at - 1] === '.') {
      // promise form: .catch( <arrow> )
      if (s[i] !== '(') continue;
      i = skipSpaces(s, i + 1);
      if (startsWord(s, i, 'async')) i = skipSpaces(s, i + 5);
      if (s[i] === '(') {
        const end = matching(s, i);
        if (end === -1) continue;
        i = end;
      } else if (isIdentChar(s[i])) {
        while (isIdentChar(s[i])) i++;
      } else continue;
      i = skipSpaces(s, i);
      if (s[i] !== '=' || s[i + 1] !== '>') continue;
      i = skipSpaces(s, i + 2);
      if (s[i] === '{') {
        const end = matching(s, i);
        if (end !== -1 && s.slice(i + 1, end - 1).trim() === '') found.push(at);
        continue;
      }
      for (const lit of ['undefined', 'null', 'void 0']) {
        if (startsWord(s, i, lit) && s[skipSpaces(s, i + lit.length)] === ')') found.push(at);
      }
      continue;
    }
    // try form: catch [ (binding) ] { body }
    if (s[i] === '(') {
      const end = matching(s, i);
      if (end === -1) continue;
      i = skipSpaces(s, end);
    }
    if (s[i] !== '{') continue;
    const end = matching(s, i);
    if (end !== -1 && s.slice(i + 1, end - 1).trim() === '') found.push(at);
  }
  return found;
}
