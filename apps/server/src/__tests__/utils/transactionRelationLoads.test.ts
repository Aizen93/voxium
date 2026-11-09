import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, relative, dirname, join, sep } from 'node:path';
import ts from 'typescript';

/**
 * Source guard: nothing may put two queries at once on one pg connection.
 *
 * Measured on Prisma 7.10.1, @prisma/adapter-pg 7.10.1, pg 8.20.0. Without
 * the relationJoins preview feature, Prisma loads each relation of an
 * include/select as its OWN query and runs sibling relations with
 * Promise.all. Inside a transaction they all land on its ONE connection:
 * an interactive or array $transaction, and also the transaction Prisma
 * opens itself around a root create/update/upsert/delete that returns
 * relations (BEGIN, the write, the re-read, the relation queries, COMMIT).
 * pg 8 queues them and deprecates it ("Calling client.query() when the
 * client is already executing a query is deprecated"); pg 9 removes it.
 *
 * With relationJoins every relation load is ONE statement (LEFT JOIN
 * LATERAL + JSONB), the default strategy. So this guard pins:
 * 1. the schema's generator enables relationJoins;
 * 2. no query opts back out with `relationLoadStrategy: 'query'` on a
 *    shape loading two or more relations (one relation is a parent query
 *    plus one child, never two at once). Every `relationLoadStrategy` key
 *    must sit in a query's own argument literal, with a literal value, or
 *    the scan cannot check it and refuses it;
 * 3. no findUnique / findUniqueOrThrow on a transaction client is issued
 *    together (Promise.all/allSettled/race/any) with another operation on
 *    it. Prisma batches same-tick operations of one interactive
 *    transaction under one key and runs that batch sequentially, but a
 *    findUnique gets a key of its own and the batches run side by side
 *    (seen on the secure-channel invite). `Promise.all([tx.a.findFirst(),
 *    tx.a.count()])` lands in one batch and is allowed.
 *
 * Not seen by the scan: operations on a transaction client started in
 * different ticks without being awaited. Await each before the next.
 */

const SERVER_ROOT = resolve(__dirname, '../../..');
const SRC = resolve(SERVER_ROOT, 'src');
const SCHEMA = resolve(SERVER_ROOT, 'prisma/schema.prisma');

// ─── Schema ──────────────────────────────────────────────────────────────────

/** The generator block's previewFeatures, or [] when it has none. */
function generatorPreviewFeatures(schema: string): string[] {
  const block = /^generator\s+client\s*\{([\s\S]*?)^\}/m.exec(schema)?.[1] ?? '';
  const line = /^\s*previewFeatures\s*=\s*\[([^\]]*)\]/m.exec(block)?.[1] ?? '';
  return [...line.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/** model -> relation field -> related model */
function parseSchemaRelations(schema: string): Map<string, Map<string, string>> {
  const blocks = [...schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)];
  const models = new Set(blocks.map((b) => b[1]));
  const relations = new Map<string, Map<string, string>>();
  for (const [, name, body] of blocks) {
    const fields = new Map<string, string>();
    for (const line of body.split('\n')) {
      const m = /^\s*([A-Za-z_]\w*)\s+([A-Za-z_]\w*)(\[\])?\??(\s|$)/.exec(line);
      if (m && models.has(m[2])) fields.set(m[1], m[2]);
    }
    relations.set(name, fields);
  }
  return relations;
}

// ─── The scan ────────────────────────────────────────────────────────────────

interface ScanResult { violations: string[]; strategyKeys: number; transactions: number }
type Resolved = Map<string, ts.Expression> | null;

function unwrap(node: ts.Expression): ts.Expression {
  let n = node;
  while (ts.isAsExpression(n) || ts.isSatisfiesExpression(n) || ts.isParenthesizedExpression(n)) n = n.expression;
  return n;
}

function keyOf(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return null;
}

class Scanner {
  private files = new Map<string, ts.SourceFile>();
  readonly result: ScanResult = { violations: [], strategyKeys: 0, transactions: 0 };

  constructor(private relations: Map<string, Map<string, string>>) {}

  private source(path: string, text?: string): ts.SourceFile {
    let sf = this.files.get(path);
    if (!sf) {
      sf = ts.createSourceFile(path, text ?? readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
      this.files.set(path, sf);
    }
    return sf;
  }

  private where(node: ts.Node): string {
    const sf = node.getSourceFile();
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    return `${relative(SRC, sf.fileName).split(sep).join('/')}:${line}`;
  }

  /** The initializer of a `const NAME =` in this file, or of the export a relative import names. */
  private declarationOf(name: string, sf: ts.SourceFile): ts.Expression | null {
    let found: ts.Expression | null = null;
    const visit = (n: ts.Node) => {
      if (found) return;
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer) {
        found = n.initializer;
        return;
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    if (found) return found;
    for (const st of sf.statements) {
      if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
      const spec = st.moduleSpecifier.text;
      const named = st.importClause?.namedBindings;
      if (!spec.startsWith('.') || !named || !ts.isNamedImports(named)) continue;
      const el = named.elements.find((e) => e.name.text === name);
      if (!el) continue;
      const base = resolve(dirname(sf.fileName), spec);
      const target = [`${base}.ts`, join(base, 'index.ts')].find((p) => existsSync(p));
      if (!target) return null;
      return this.declarationOf(el.propertyName?.text ?? name, this.source(target));
    }
    return null;
  }

  /** An object literal's entries, following identifiers, spreads and `x.select`; null when not knowable. */
  private resolveObject(node: ts.Expression, sf: ts.SourceFile, depth = 0): Resolved {
    if (depth > 20) return null;
    const n = unwrap(node);
    if (ts.isIdentifier(n)) {
      const decl = this.declarationOf(n.text, sf);
      return decl ? this.resolveObject(decl, decl.getSourceFile(), depth + 1) : null;
    }
    if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.name)) {
      const base = this.resolveObject(n.expression, sf, depth + 1);
      const entry = base?.get(n.name.text);
      return entry ? this.resolveObject(entry, entry.getSourceFile(), depth + 1) : null;
    }
    if (!ts.isObjectLiteralExpression(n)) return null;
    const out = new Map<string, ts.Expression>();
    for (const p of n.properties) {
      if (ts.isPropertyAssignment(p)) {
        const k = keyOf(p.name);
        if (k === null) return null;
        out.set(k, p.initializer);
      } else if (ts.isShorthandPropertyAssignment(p)) {
        out.set(p.name.text, p.name);
      } else if (ts.isSpreadAssignment(p)) {
        const inner = this.resolveObject(p.expression, sf, depth + 1);
        if (!inner) return null;
        for (const [k, v] of inner) out.set(k, v);
      } else {
        return null;
      }
    }
    return out;
  }

  /** How many relations a query's select/include tree loads, `_count` excluded; null when not knowable. */
  private relationCount(args: Map<string, ts.Expression>, model: string): number | null {
    const fields = this.relations.get(model);
    if (!fields) return null;
    let n = 0;
    for (const kind of ['include', 'select'] as const) {
      const value = args.get(kind);
      if (!value) continue;
      const level = this.resolveObject(value, value.getSourceFile());
      if (!level) return null;
      for (const [key, v] of level) {
        if (key === '_count' || unwrap(v).kind === ts.SyntaxKind.FalseKeyword) continue;
        const related = fields.get(key);
        if (!related) {
          if (kind === 'include') return null;
          continue; // a scalar
        }
        n++;
        const vv = unwrap(v);
        if (vv.kind === ts.SyntaxKind.TrueKeyword) continue;
        const nested = this.resolveObject(vv, vv.getSourceFile());
        if (!nested) return null;
        const below = this.relationCount(nested, related);
        if (below === null) return null;
        n += below;
      }
    }
    return n;
  }

  /** Rule 2, for one `relationLoadStrategy` key. */
  private checkStrategyKey(prop: ts.PropertyAssignment | ts.ShorthandPropertyAssignment) {
    this.result.strategyKeys++;
    const at = this.where(prop);
    const obj = prop.parent;
    const call = obj.parent;
    const callee = ts.isCallExpression(call) ? call.expression : null;
    if (!ts.isObjectLiteralExpression(obj) || !call || !ts.isCallExpression(call) || call.arguments[0] !== obj
      || !callee || !ts.isPropertyAccessExpression(callee) || !ts.isPropertyAccessExpression(callee.expression)) {
      this.result.violations.push(`${at}: relationLoadStrategy outside a query's own argument literal cannot be checked`);
      return;
    }
    const value = ts.isPropertyAssignment(prop) ? unwrap(prop.initializer) : null;
    if (!value || !ts.isStringLiteralLike(value)) {
      this.result.violations.push(`${at}: relationLoadStrategy must be a string literal ('join' or 'query')`);
      return;
    }
    if (value.text !== 'query') return;
    const delegate = callee.expression.name.text;
    const model = delegate.charAt(0).toUpperCase() + delegate.slice(1);
    const args = this.resolveObject(obj, obj.getSourceFile());
    const n = args ? this.relationCount(args, model) : null;
    if (n === null) {
      this.result.violations.push(`${at}: relationLoadStrategy 'query' on a shape the scan cannot resolve`);
    } else if (n >= 2) {
      this.result.violations.push(
        `${at} ${delegate}.${callee.name.text}: relationLoadStrategy 'query' on a shape loading ${n} relations`
        + ' runs their queries at once (on one connection inside a transaction)',
      );
    }
  }

  /** `<root>.<delegate>.<op>(...)` → [delegate, op], else null. */
  private static opCall(call: ts.CallExpression, root: string): [string, string] | null {
    const callee = call.expression;
    if (!ts.isPropertyAccessExpression(callee)) return null;
    const target = callee.expression;
    if (!ts.isPropertyAccessExpression(target) || !ts.isIdentifier(target.expression)) return null;
    if (target.expression.text !== root || target.name.text.startsWith('$')) return null;
    return [target.name.text, callee.name.text];
  }

  /** Rule 3, inside one interactive transaction callback. */
  private checkConcurrentFindUnique(fn: ts.ArrowFunction | ts.FunctionExpression) {
    const param = fn.parameters[0];
    if (!param || !ts.isIdentifier(param.name)) return;
    const tx = param.name.text;
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression)
        && n.expression.expression.text === 'Promise' && ['all', 'allSettled', 'race', 'any'].includes(n.expression.name.text)
        && n.arguments[0]) {
        const sites: string[] = [];
        const collect = (m: ts.Node) => {
          if (ts.isCallExpression(m)) {
            const op = Scanner.opCall(m, tx);
            if (op) sites.push(`${op[0]}.${op[1]}`);
          }
          ts.forEachChild(m, collect);
        };
        collect(n.arguments[0]);
        if (sites.length >= 2 && sites.some((s) => /\.findUnique(OrThrow)?$/.test(s))) {
          this.result.violations.push(
            `${this.where(n)} Promise.${n.expression.name.text}(${sites.join(', ')}): a findUnique is batched apart from`
            + ' the other operations, so they run at once on the transaction\'s one pg connection; await them one after the other',
          );
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(fn.body);
  }

  scan(path: string, text?: string) {
    const sf = this.source(path, text);
    const visit = (n: ts.Node) => {
      if ((ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) && keyOf(n.name) === 'relationLoadStrategy') {
        this.checkStrategyKey(n);
      }
      // The key by any other spelling ('relationLoadStrategy' as a computed or element access)
      if (ts.isStringLiteralLike(n) && n.text === 'relationLoadStrategy'
        && !(ts.isPropertyAssignment(n.parent) && n.parent.name === n)) {
        this.result.violations.push(`${this.where(n)}: relationLoadStrategy named indirectly cannot be checked`);
      }
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)
        && n.expression.name.text === '$transaction' && n.arguments[0]) {
        this.result.transactions++;
        const first = n.arguments[0];
        if (ts.isArrowFunction(first) || ts.isFunctionExpression(first)) this.checkConcurrentFindUnique(first);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'generated' || entry === '__tests__' || entry === 'node_modules') continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (p.endsWith('.ts') && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

const schemaText = readFileSync(SCHEMA, 'utf8');
const relations = parseSchemaRelations(schemaText);

function scanSnippet(code: string): ScanResult {
  const s = new Scanner(relations);
  s.scan(join(SRC, '__snippet__.ts'), code);
  return s.result;
}

// ─── The guard ───────────────────────────────────────────────────────────────

describe('Prisma loads relations with joins, never with concurrent queries on one connection', () => {
  const scanner = new Scanner(relations);
  for (const file of sourceFiles(SRC)) scanner.scan(file);
  const { violations, transactions } = scanner.result;

  it('the schema generator enables relationJoins', () => {
    expect(generatorPreviewFeatures(schemaText)).toContain('relationJoins');
  });

  it('scans the real source (the guard is not looking at nothing)', () => {
    expect(relations.get('Message')?.get('author')).toBe('User');
    expect(transactions).toBeGreaterThanOrEqual(25);
  });

  it('finds no opt-out to the query strategy on a multi-relation shape and no concurrent findUnique on a transaction client', () => {
    expect(violations).toEqual([]);
  });
});

describe('the scan itself (controls)', () => {
  it('reads the generator block, and only it', () => {
    expect(generatorPreviewFeatures('generator client {\n  provider = "prisma-client"\n}\n')).toEqual([]);
    expect(generatorPreviewFeatures('generator client {\n  provider        = "prisma-client"\n  previewFeatures = ["relationJoins", "x"]\n}\n'))
      .toEqual(['relationJoins', 'x']);
    expect(generatorPreviewFeatures('generator client {\n  provider = "prisma-client"\n}\n// previewFeatures = ["relationJoins"]\n')).toEqual([]);
  });

  const SELECTS = `
    const authorSelect = { select: { id: true, username: true } } as const;
    const replyToSelect = { select: { id: true, content: true, author: authorSelect } } as const;
  `;

  it("refuses relationLoadStrategy: 'query' on two or more relations (siblings, a chain, or `relation: true` in a select)", () => {
    const r = scanSnippet(`${SELECTS}
      export const a = () => prisma.message.findMany({ include: { author: authorSelect, attachments: true }, relationLoadStrategy: 'query' });
      export const b = () => prisma.message.findMany({ include: { replyTo: replyToSelect }, relationLoadStrategy: 'query' });
      export const c = () => prisma.webhook.update({ where: { id: 'w' }, data: {}, select: { id: true, createdBy: true, lastRotatedBy: true }, relationLoadStrategy: 'query' });`);
    expect(r.violations).toEqual([
      expect.stringMatching(/message\.findMany: relationLoadStrategy 'query' on a shape loading 2 relations/),
      expect.stringMatching(/message\.findMany: relationLoadStrategy 'query' on a shape loading 2 relations/),
      expect.stringMatching(/webhook\.update: relationLoadStrategy 'query' on a shape loading 2 relations/),
    ]);
  });

  it("allows 'query' on a single relation, `_count`, and 'join' on anything", () => {
    const r = scanSnippet(`${SELECTS}
      export const a = () => prisma.memberRole.findMany({ where: {}, include: { role: { select: { permissions: true } } }, relationLoadStrategy: 'query' });
      export const b = () => prisma.server.findMany({ include: { channels: true, _count: { select: { members: true } } }, relationLoadStrategy: 'query' });
      export const c = () => prisma.message.findMany({ include: { author: authorSelect, replyTo: replyToSelect, attachments: true }, relationLoadStrategy: 'join' });`);
    expect(r.violations).toEqual([]);
    expect(r.strategyKeys).toBe(3);
  });

  it('fails closed on a strategy it cannot check: outside the argument literal, not a literal, or named indirectly', () => {
    const r = scanSnippet(`
      const opts = { relationLoadStrategy: 'query' } as const;
      export const a = (s: 'join' | 'query') => prisma.message.findMany({ include: { author: true }, relationLoadStrategy: s });
      export const b = () => prisma.message.findMany({ include: { author: true }, ...opts });
      export const c = (args: Record<string, unknown>) => { args['relationLoadStrategy'] = 'query'; };`);
    expect(r.violations).toEqual([
      expect.stringMatching(/relationLoadStrategy outside a query's own argument literal cannot be checked/),
      expect.stringMatching(/relationLoadStrategy must be a string literal/),
      expect.stringMatching(/relationLoadStrategy named indirectly cannot be checked/),
    ]);
  });

  it('flags a findUnique issued together with another operation on the transaction client (the pre-fix secure-channel invite)', () => {
    const r = scanSnippet(`
      export const f = (channelId: string, userId: string) => prisma.$transaction(async (tx) => {
        await tx.$queryRaw\`SELECT id FROM channels WHERE id = \${channelId} FOR UPDATE\`;
        const [existing, memberCount] = await Promise.all([
          tx.channelMember.findUnique({ where: { channelId_userId: { channelId, userId } }, select: { userId: true } }),
          tx.channelMember.count({ where: { channelId } }),
        ]);
        return { existing, memberCount };
      });`);
    expect(r.violations).toEqual([
      expect.stringMatching(/Promise\.all\(channelMember\.findUnique, channelMember\.count\): a findUnique is batched apart/),
    ]);
  });

  it('passes Promise.all over operations that share one batch, and awaited findUniques', () => {
    const r = scanSnippet(`
      export const f = () => prisma.$transaction(async (tx) => {
        await Promise.all([tx.channelMember.findMany({ select: { userId: true } }), tx.channel.count()]);
        const one = await tx.channelMember.findUnique({ where: { channelId_userId: { channelId: 'c', userId: 'u' } } });
        const n = await tx.channelMember.count();
        return { one, n };
      });`);
    expect(r.violations).toEqual([]);
    expect(r.transactions).toBe(1);
  });

  it('resolves shapes through local consts, spreads and `x.select` before counting', () => {
    const r = scanSnippet(`
      const authorSelect = { select: { id: true, username: true } } as const;
      const base = { include: { author: { select: authorSelect.select } } } as const;
      export const a = () => prisma.message.findMany({ ...base, relationLoadStrategy: 'query' });
      export const b = () => prisma.message.findMany({ include: { ...base.include, attachments: true }, relationLoadStrategy: 'query' });`);
    expect(r.violations).toEqual([expect.stringMatching(/:5 message\.findMany: relationLoadStrategy 'query' on a shape loading 2 relations/)]);
  });
});
