import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

// `conversations.updated_at` is Prisma's @updatedAt and orders BOTH people's
// conversation lists (GET /dm, `orderBy: { updatedAt: 'desc' }`): any write
// to a conversation row moves it up the other person's list. Removing a
// conversation is one person's act (#47) and must tell the other person
// nothing, so its state lives on the remover's own `conversation_reads` row
// and nothing writes the `conversations` row except:
//   - its creation (POST /dm);
//   - the list-order bump after a NEW MESSAGE (writeConversationMessage, the
//     one writer of DM messages, the send route and the call notices alike),
//     which is meant to move it up both lists;
//   - the real deletion of a conversation nobody can reach any more
//     (removeConversationForUser), which nobody sees.
// Every Prisma write to the model (on any client, a chain split over lines
// included), every nested write that reaches a conversation row through a
// relation (`message.update({ data: { conversation: { update: … } } })`,
// `user.update({ data: { conversationsAsUser1: { updateMany: … } } })`) and
// every raw statement that writes the table (schema-qualified or not, on one
// line or over several) is counted here, file by file; a new one fails until
// it is reviewed against that rule and counted with its reason. The scan
// reads each file as one text with its comment-only lines left out.
//
// What still slips through: a write through a computed key
// (`prisma['conversation']`, `client[model]`) or through a delegate kept in a
// variable (`const c = tx.conversation; c.update(…)`); a nested write whose
// `data` is built elsewhere and passed in; raw SQL that builds the table name
// or arrives in a variable (`$executeRawUnsafe(sql)`); code on a line that
// starts like a comment; and the cascade of a delete elsewhere (an account
// deletion), which deletes rows rather than moving them.

const SRC = path.resolve(__dirname, '../..');

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

const isCommentLine = (line: string) => /^\s*(\/\/|\/\*|\*)/.test(line);

/** The code of a text as one string, comment-only lines left out, so a pattern can cross lines. */
const codeOf = (text: string) => text.split(/\r?\n/).filter((line) => !isCommentLine(line)).join('\n');

function countIn(text: string, pattern: RegExp): number {
  return [...codeOf(text).matchAll(pattern)].length;
}

// `.conversation.update(`, and the same chain split over lines
const MODEL_WRITE = /\.\s*conversation\s*\.\s*(?:create|createMany|createManyAndReturn|update|updateMany|updateManyAndReturn|upsert|delete|deleteMany)\s*\(/g;
// Through a relation: from a message (`conversation: { update: … }`; a
// connect only sets the message's own key) or from an account (every write on
// `conversationsAsUser1` / `2` writes conversation rows, a connect included)
const NESTED_WRITE = /\bconversation\s*:\s*\{\s*(?:create|connectOrCreate|update|upsert|delete)\s*:|\bconversationsAsUser[12]\s*:\s*\{\s*(?:create|createMany|connectOrCreate|connect|update|updateMany|upsert|delete|deleteMany|set|disconnect)\s*:/g;
const RAW_WRITE = /\b(?:UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+(?:"?public"?\s*\.\s*)?"?conversations"?(?=[\s"(;`]|$)/gi;

const ALLOWED: Record<string, { count: number; reason: string }> = {
  'routes/dm.ts': { count: 1, reason: 'POST /dm creates a conversation for a new pair' },
  'utils/conversationLifecycle.ts': { count: 2, reason: 'the list-order bump after a new message (writeConversationMessage), and the delete of a conversation nobody can reach (removeConversationForUser)' },
};

/** The body of one exported function of a file, up to the next top-level declaration. */
function functionBody(text: string, name: string): string {
  const start = text.indexOf(`export function ${name}(`);
  const fallback = text.indexOf(`export async function ${name}`);
  const from = start >= 0 ? start : fallback;
  expect(from, name).toBeGreaterThanOrEqual(0);
  const rest = text.slice(from + 1);
  const next = rest.search(/\n(?:export |const |function |async function |\/\*\*)/);
  return next < 0 ? rest : rest.slice(0, next);
}

describe('writes to the conversations row', () => {
  it('scans the server sources', () => {
    expect(files.map((f) => f.rel)).toContain('utils/conversationLifecycle.ts');
  });

  it('counts every Prisma write to the Conversation model against the reviewed list, file by file', () => {
    const found: Record<string, number> = {};
    for (const { rel, text } of files) {
      const n = countIn(text, MODEL_WRITE);
      if (n > 0) found[rel] = n;
    }
    const expected = Object.fromEntries(Object.entries(ALLOWED).map(([rel, { count }]) => [rel, count]));
    expect(found, 'a write to a conversation row moves it up the other person\'s list: review it against #47, then count it here with its reason').toEqual(expected);
  });

  it('no raw statement writes the table', () => {
    const found: Record<string, number> = {};
    for (const { rel, text } of files) {
      const n = countIn(text, RAW_WRITE);
      if (n > 0) found[rel] = n;
    }
    expect(found).toEqual({});
  });

  it('no nested write reaches a conversation row through a relation', () => {
    const found: Record<string, number> = {};
    for (const { rel, text } of files) {
      const n = countIn(text, NESTED_WRITE);
      if (n > 0) found[rel] = n;
    }
    expect(found).toEqual({});
  });

  it('a removal writes the row only to delete it, after deciding nobody can reach it; a reopen never writes it', () => {
    const lifecycle = files.find((f) => f.rel === 'utils/conversationLifecycle.ts')!.text;
    const removal = functionBody(lifecycle, 'removeConversationForUser');
    expect(countIn(removal, MODEL_WRITE)).toBe(1);
    expect(countIn(removal, /\btx\.conversation\.delete\(/g)).toBe(1);
    expect(removal.indexOf('tx.conversation.delete(')).toBeGreaterThan(removal.indexOf('nobodyCanReach('));
    expect(countIn(removal, /prisma\.conversation\./g)).toBe(0);

    const reopen = functionBody(lifecycle, 'reopenConversationForUser');
    expect(countIn(reopen, MODEL_WRITE)).toBe(0);

    const write = functionBody(lifecycle, 'writeConversationMessage');
    expect(countIn(write, /prisma\.conversation\.updateMany\(/g)).toBe(1);
  });

  it('the route that removes a conversation writes no conversation row itself', () => {
    const dm = files.find((f) => f.rel === 'routes/dm.ts')!.text;
    const start = dm.indexOf("dmRouter.delete('/:conversationId',");
    expect(start).toBeGreaterThan(0);
    const route = dm.slice(start, dm.indexOf('dmRouter.', start + 10));
    expect(countIn(route, MODEL_WRITE)).toBe(0);
    expect(route).toContain('removeConversationForUser(');
  });

  describe('the patterns themselves', () => {
    it('catch every kind of write, on any client', () => {
      for (const line of [
        'await prisma.conversation.update({ where: { id }, data: {} });',
        'await tx.conversation.updateMany({ where: {}, data: {} });',
        'db.conversation.upsert({',
        'await prisma.conversation.delete({ where: { id } })',
        'prisma.conversation.createMany({ data: [] })',
        // a chain split over lines
        'await tx\n      .conversation\n      .update({ where: { id }, data: {} });',
        'await prisma.\n  conversation.\n  deleteMany({});',
      ]) {
        expect(countIn(line, MODEL_WRITE), line).toBe(1);
      }
      for (const line of [
        "await tx.$executeRaw`UPDATE conversations SET updated_at = now() WHERE id = ${id}`;",
        "await tx.$executeRaw`UPDATE \"conversations\" SET x = 1`;",
        '`DELETE FROM conversations WHERE id = $1`',
        'INSERT INTO conversations (id) VALUES ($1)',
        'UPDATE "public"."conversations" SET updated_at = now()',
        'DELETE FROM public.conversations WHERE id = $1',
        // the statement over two lines
        'await tx.$executeRaw`\n  UPDATE\n    conversations SET updated_at = now() WHERE id = ${id}`;',
      ]) {
        expect(countIn(line, RAW_WRITE), line).toBe(1);
      }
      for (const text of [
        'prisma.message.update({ where: { id }, data: { conversation: { update: { updatedAt: new Date() } } } });',
        'tx.message.create({ data: { content, conversation: {\n  create: { user1Id, user2Id } } } });',
        'prisma.user.update({ where: { id }, data: { conversationsAsUser1: { updateMany: { where: {}, data: {} } } } });',
        'prisma.user.update({ data: { conversationsAsUser2: { connect: { id } } } });',
        'prisma.user.update({ data: { conversationsAsUser1: { deleteMany: {} } } });',
      ]) {
        expect(countIn(text, NESTED_WRITE), text).toBe(1);
      }
    });

    it('leave reads, the read rows, a message\'s own key and comments alone', () => {
      for (const line of [
        'await prisma.conversation.findUnique({ where: { id } });',
        'await prisma.conversation.findMany({});',
        'await tx.conversationRead.updateMany({ where: {}, data: {} });',
        'prisma.conversationRead.upsert({',
        'INSERT INTO conversation_reads (user_id) VALUES ($1)',
        'SELECT id FROM conversations WHERE id = $1 FOR UPDATE',
        "SELECT id FROM conversations WHERE id = ${conversationId} FOR UPDATE`;\n  const next = 1;",
        'tx.message.create({ data: { conversation: { connect: { id } } } });',
        'include: { conversation: { select: { id: true } } },',
        'where: { conversation: { user1Id: userId } },',
        '  // await prisma.conversation.update({ where: { id }, data: {} });',
        '   * UPDATE conversations SET …',
      ]) {
        expect(countIn(line, MODEL_WRITE) + countIn(line, RAW_WRITE) + countIn(line, NESTED_WRITE), line).toBe(0);
      }
    });
  });
});
