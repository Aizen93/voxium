import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

// `conversations.user1_id` / `user2_id` are nullable (migration
// 20261116120000_conversation_lifecycle_expand): a NULL side is a deleted
// account. The Prisma readers are typed (`string | null`) and compare a side
// with the caller (`null !== userId`); the readers the compiler cannot check
// are counted here, file by file:
//   - raw SQL naming the columns (a string to TypeScript), where `=` and
//     `!=` against NULL silently drop rows and `IS DISTINCT FROM` may be
//     meant; there is none today;
//   - code picking the other side's loaded account (`.user1` / `.user2`, or
//     destructured), which must give the deleted-account placeholder for a
//     NULL side, as otherParticipant() does: a bare pick sends
//     `participant: null`, and a 2.1.x desktop reads `participant.avatarUrl`
//     unguarded;
//   - code picking the other side's id (`a.user1Id === me ? a.user2Id :
//     a.user1Id`, optional chaining included), or putting a side id into a
//     string (a template or a `+`), where a NULL side becomes the text
//     "null" (`user:null`) and nothing complains.
// A new reader is reviewed for the NULL side, then counted below with the
// reason it is right; a second pick in a listed file fails like a first one
// anywhere else.
//
// What still slips through: a pick written over several lines (the scan is
// per line), one through a computed key (`c['user2']`), an if/else instead of
// a ternary, an array pick (`[c.user1Id, c.user2Id].find(…)`), a side id
// copied to a local and used later, or coerced by a call (`String(c.user2Id)`),
// a whole row spread or passed on (`...c`, `send(c)`), raw SQL that builds
// the column name, and any reader outside apps/server/src (scripts/,
// tests/e2e).

const SRC = path.resolve(__dirname, '../..');

/** Every TypeScript source file of the server, tests and the generated client left out. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'generated' || entry === 'node_modules') continue;
      out.push(...sourceFiles(full));
    } else if (/\.ts$/.test(entry) && !/\.test\.ts$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const files = sourceFiles(SRC).map((full) => ({
  rel: path.relative(SRC, full).split(path.sep).join('/'),
  text: readFileSync(full, 'utf8'),
}));

/** A line that is only a comment (`//`, or a line of a block comment): it reads nothing. */
function isCommentLine(line: string): boolean {
  return /^\s*(\/\/|\/\*|\*)/.test(line);
}

/** How many times a (global) pattern matches the code lines of a text. */
function countIn(text: string, pattern: RegExp): number {
  let n = 0;
  for (const line of text.split(/\r?\n/)) {
    if (isCommentLine(line)) continue;
    n += [...line.matchAll(pattern)].length;
  }
  return n;
}

interface Rule {
  what: string;
  pattern: RegExp;
  /** file (relative to src/) → how many matches it may hold, and why each is right */
  allowed: Record<string, { count: number; reason: string }>;
}

const RULES: Rule[] = [
  {
    what: 'raw SQL naming user1_id / user2_id',
    pattern: /\buser[12]_id\b/gi,
    allowed: {
      'utils/registrationHygiene.ts': { count: 4, reason: 'the sweep locks every conversation of the accounts it deletes (both sides read; `= ANY` of the swept ids, which a NULL side never matches, so a conversation whose other side is NULL is still found by the swept side) before the conversation step of each account that is a side' },
      'utils/conversationLifecycle.ts': { count: 10, reason: 'settleConversationsOfDeletedAccount: the lock of the deleted account\'s conversations (both sides read, `=` against the account\'s own id, which a NULL side never equals: a conversation whose other side is NULL is still found by the account\'s side) and the CASE that sets only the account\'s side NULL (a side that is not the account is written back as it was, NULL included)' },
    },
  },
  {
    what: 'pick of a loaded side (.user1 / .user2)',
    pattern: /\.user[12]\b(?!Id)/g,
    allowed: {
      'utils/deletedParticipant.ts': { count: 2, reason: 'otherParticipant(): a NULL side gives the placeholder and participantDeleted: true' },
    },
  },
  {
    what: 'destructured side (const { user1, user2 } = c, or as a parameter)',
    pattern: /\b(?:const|let|var)\s*\{[^{}]*\buser[12](?:Id)?\b[^{}]*\}\s*=|\(\s*\{[^{}]*\buser[12](?:Id)?\b[^{}]*\}\s*(?::[^()]*)?\)\s*(?:=>|\{)/g,
    allowed: {},
  },
  {
    what: 'pick of the other side\'s id (… ? x.user2Id : x.user1Id)',
    // `?` in the class: an optional chain (`c?.user2Id`) is a pick too
    pattern: /\?\s*[\w$.?]*\.user[12]Id\s*:\s*[\w$.?]*\.user[12]Id\b/g,
    allowed: {
      'routes/e2e.ts': { count: 1, reason: 'the key-share gate: a NULL other side is compared with a string recipient id, so only the sender\'s own devices pass' },
      'utils/conversationLifecycle.ts': { count: 1, reason: 'settleConversationsOfDeletedAccount: the other side of a deleted account\'s conversation; a NULL one (that account is gone too) sends the conversation to the delete, and is never put into a string' },
    },
  },
  {
    what: 'side id interpolated into a string (`user:${c.user2Id}`)',
    pattern: /\$\{[^}]*\.user[12]Id\b[^}]*\}/g,
    allowed: {},
  },
  {
    what: 'side id concatenated into a string (\'user:\' + c.user2Id)',
    // after a `+` (or `+=`), or before one
    pattern: /\+=?\s*[\w$.?]*\.user[12]Id\b|[\w$?]\.user[12]Id\s*\+(?!\+)/g,
    allowed: {},
  },
];

describe('readers of a conversation side', () => {
  it('scans the server sources (and only them)', () => {
    const rels = files.map((f) => f.rel);
    expect(rels).toContain('routes/dm.ts');
    expect(rels).toContain('utils/deletedParticipant.ts');
    expect(rels.some((r) => r.startsWith('__tests__/') || r.startsWith('generated/'))).toBe(false);
  });

  for (const rule of RULES) {
    it(`counts every ${rule.what} against the reviewed list, file by file`, () => {
      const found: Record<string, number> = {};
      for (const { rel, text } of files) {
        const n = countIn(text, rule.pattern);
        if (n > 0) found[rel] = n;
      }
      const expected = Object.fromEntries(Object.entries(rule.allowed).map(([rel, { count }]) => [rel, count]));
      expect(found, `${rule.what}: handle a NULL side (a deleted account), then count the reader in RULES with its reason`).toEqual(expected);
    });
  }

  it('the DM readers shape their rows with the conversation they read (never the generic, select-dependent shapers)', () => {
    for (const rel of ['routes/dm.ts', 'websocket/dmVoiceHandler.ts']) {
      const text = files.find((f) => f.rel === rel)!.text;
      expect(countIn(text, /\bshape(?:MessageRow|MessageAuthor)\(/g), rel).toBe(0);
      expect(countIn(text, /\bshapeConversationMessage(?:Row|Author)\(/g), rel).toBeGreaterThan(0);
    }
  });

  describe('the patterns themselves', () => {
    const rule = (what: string) => RULES.find((r) => r.what.startsWith(what))!.pattern;
    const hits = (pattern: RegExp, line: string) => countIn(line, pattern);

    it('catch each kind of reader', () => {
      expect(hits(rule('raw SQL'), 'SELECT c.id FROM conversations c WHERE c.user1_id = $1')).toBe(1);
      expect(hits(rule('pick of a loaded side'), 'participant: c.user1Id === userId ? c.user2 : c.user1,')).toBe(2);
      expect(hits(rule('destructured side'), 'const { user1, user2 } = conversation;')).toBe(1);
      expect(hits(rule('destructured side'), 'const { id, user2Id } = conv;')).toBe(1);
      expect(hits(rule('destructured side'), 'const pick = ({ user1, user2 }: Row) => user1 ?? user2;')).toBe(1);
      expect(hits(rule('destructured side'), 'function other({ user1Id, user2Id }) {')).toBe(1);
      expect(hits(rule('pick of the other side'), 'const other = conv.user1Id === me ? conv.user2Id : conv.user1Id;')).toBe(1);
      expect(hits(rule('side id interpolated'), 'io.to(`user:${conv.user2Id}`).emit(event);')).toBe(1);
    });

    it('catch a ternary pick written with optional chaining', () => {
      expect(hits(rule('pick of the other side'), 'const other = c?.user1Id === me ? c?.user2Id : c?.user1Id;')).toBe(1);
      expect(hits(rule('pick of the other side'), 'const other = a?.b?.user1Id === me ? a?.b?.user2Id : a.b.user1Id;')).toBe(1);
    });

    it('catch a side id concatenated into a string, on either side of the +', () => {
      expect(hits(rule('side id concatenated'), "io.to('user:' + c.user2Id).emit(event);")).toBe(1);
      expect(hits(rule('side id concatenated'), "const room = c?.user1Id + ':dm';")).toBe(1);
      expect(hits(rule('side id concatenated'), 'key += c.user2Id;')).toBe(1);
      expect(hits(rule('side id concatenated'), "'a' + c.user1Id + 'b' + c.user2Id")).toBe(2);
    });

    it('do not see an array pick (named in the header as a gap)', () => {
      for (const r of RULES) expect(hits(r.pattern, 'const other = [c.user1Id, c.user2Id].find((id) => id !== me);'), r.what).toBe(0);
    });

    it('count a second pick on the same line', () => {
      expect(hits(rule('side id interpolated'), 'x(`user:${c.user1Id}`, `user:${c.user2Id}`)')).toBe(2);
    });

    it('leave the typed readers alone: a side compared with the caller, an include or select key, a where filter, the compound key, a local pair', () => {
      for (const line of [
        'if (conv.user1Id !== userId && conv.user2Id !== userId) {',
        'include: { user1: authorSelect, user2: authorSelect },',
        'const conv = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { user1Id: true, user2Id: true } });',
        'where: { OR: [{ user1Id: userId }, { user2Id: userId }] },',
        "where: { user1Id_user2Id: { user1Id, user2Id } },",
        'const [user1Id, user2Id] = sortUserIds(currentUserId, targetUserId);',
        'io.in(`user:${user1Id}`).socketsJoin(`dm:${conversation.id}`);',
        'user1Id: c.user1Id,',
        'const known = c?.user1Id ?? fallback;',
        'notify(c?.user1Id, c?.user2Id);',
        'total = total + 1;',
        'const next = position + 1;',
      ]) {
        for (const r of RULES) expect(hits(r.pattern, line), `${r.what} :: ${line}`).toBe(0);
      }
    });

    it('skip comment lines: a comment reads nothing', () => {
      for (const line of [' * `conversations.user1_id` is nullable', '  // c.user2 may be null', '/* user2_id */']) {
        expect(isCommentLine(line), line).toBe(true);
      }
      expect(isCommentLine("  `SELECT 1 FROM conversations WHERE user1_id = $1`")).toBe(false);
    });
  });
});
