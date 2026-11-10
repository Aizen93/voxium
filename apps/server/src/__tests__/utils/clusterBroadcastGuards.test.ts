import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import ts from 'typescript';

/**
 * Source-shape guards for adapter-wide broadcasts whose failure mode is a
 * CLUSTER-WIDE outage rather than a wrong value — the kind nothing else in the
 * suite can see, because a unit test mocks the adapter that would have done the
 * damage and an e2e run only ever has one node.
 *
 * These assert the shape of the call, not its behaviour. That is a weak test in
 * general and the right one here: the bug is a missing `.local`, it reads like
 * a redundancy, and the next person to touch the shutdown path will write the
 * obvious thing.
 */

const SERVER = resolve(__dirname, '../..');
const read = (rel: string) => readFileSync(resolve(SERVER, rel), 'utf8');

/** Every TypeScript source under src/, tests and the generated Prisma client left out. */
function sourceFiles(dir: string = SERVER): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === '__tests__' || entry.name === 'generated' ? [] : sourceFiles(path);
    }
    return entry.name.endsWith('.ts') ? [relative(SERVER, path).split(sep).join('/')] : [];
  });
}

/** The last name of `a.b.c` / `a['b']` / `a`, or null for anything else. */
function lastName(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  if (ts.isElementAccessExpression(expr) && ts.isStringLiteralLike(expr.argumentExpression)) return expr.argumentExpression.text;
  return null;
}

interface CodeScan {
  /** How often each name occurs in CODE: identifiers and string literals, so
   *  `x.name`, `x . name (`, `x['name']` and `{ name }` all count, comments never. */
  names: Map<string, number>;
  /** Reads of `<…>.adapter.sockets` / `adapter['sockets']`. */
  adapterSockets: number;
}

/** The member a `x.name` / `x['name']` reads, or null for a computed one. */
function memberName(node: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | null {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  return ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : null;
}

/** Parsed with the TypeScript compiler, so a comment that merely mentions a
 *  name is not a call site and spacing or bracket access cannot hide one. */
function scanSource(fileName: string, text: string): CodeScan {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const names = new Map<string, number>();
  let adapterSockets = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || ts.isStringLiteralLike(node)) {
      names.set(node.text, (names.get(node.text) ?? 0) + 1);
    }
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
      && memberName(node) === 'sockets' && lastName(node.expression) === 'adapter') {
      adapterSockets++;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { names, adapterSockets };
}

const scanCode = (rel: string): CodeScan => scanSource(rel, read(rel));

describe('shutdown disconnects only THIS node', () => {
  const index = read('index.ts');

  it('calls io.local.disconnectSockets, never the bare form', () => {
    // The Redis adapter turns a bare disconnectSockets into a REMOTE_DISCONNECT
    // carrying an EMPTY room filter, which every peer applies to its entire
    // namespace. Restarting one of two production nodes therefore hung up 100%
    // of connected users cluster-wide, tearing down the surviving node's voice
    // sessions and DM calls with them — triggered by a routine deploy.
    expect(index).toContain('io.local.disconnectSockets(');
    expect(index).not.toMatch(/(?<!\.local)\bio\.disconnectSockets\(/);
  });

  it('keeps the reason for the .local next to the call', () => {
    // Without it the next reader deletes a word that looks redundant.
    expect(index).toMatch(/REMOTE_DISCONNECT/);
  });
});

describe('the socket-connect hot path never serializes every socket in the cluster', () => {
  // CLAUDE.md: io.fetchSockets() serializes every socket on every node AND
  // waits for every node's reply, so one unresponsive peer makes it throw after
  // 5s and kills everything after it in the handler. Targeted work uses
  // `user:{id}` rooms instead.
  it('socketServer.ts uses no unscoped io.fetchSockets()', () => {
    expect(read('websocket/socketServer.ts')).not.toMatch(/\bio\.fetchSockets\(/);
  });
});

describe('fetchSockets() appears only where nothing waits on its answer', () => {
  // A room-scoped fetchSockets() has the same failure mode as the unscoped
  // one: it waits for every node's reply and throws after 5 s when one peer is
  // unresponsive. The space delete route fetched the sockets of each of its
  // rooms to make them leave, so a stalled node sharing the Redis answered the
  // delete with a 500 after 5010 ms; the conversation delete and the admin
  // space deletes did the same. Room membership is an adapter operation
  // (`socketsJoin` / `socketsLeave`, `io.local` first): no call site may come
  // back without its own entry here. A file that drops its call drops its entry.
  const ALLOWED: Record<string, number> = {
    // Needs each socket's userId and rooms to recompute visibility per user;
    // every caller fires and forgets it and it logs a failure, so a stalled
    // peer fails no request (that resync is skipped until the next reconnect).
    'utils/channelVisibilityRooms.ts': 1,
    // The one-socket existence check, used only when the adapter has no
    // allRooms snapshot (never the Redis adapter); every caller skips on a
    // throw. Two names: the call, and the member of its ClusterSocketLookup type.
    'utils/redis.ts': 2,
  };

  const files = sourceFiles();
  const scans = new Map(files.map((file) => [file, scanCode(file)]));

  it('every other file under src/ names it nowhere in its code', () => {
    const found: Record<string, number> = {};
    for (const [file, scan] of scans) {
      const count = scan.names.get('fetchSockets') ?? 0;
      if (count > 0) found[file] = count;
    }
    expect(found).toEqual(ALLOWED);
  });

  it('no file uses the other every-node waits (allSockets, serverSideEmitWithAck, adapter.sockets)', () => {
    // Each asks every node and rejects when one does not answer in time, like
    // fetchSockets; none is used today, and a new use needs its own allowance
    const found: Record<string, Record<string, number>> = {};
    for (const [file, scan] of scans) {
      const uses: Record<string, number> = {};
      for (const name of ['allSockets', 'serverSideEmitWithAck']) {
        const count = scan.names.get(name) ?? 0;
        if (count > 0) uses[name] = count;
      }
      if (scan.adapterSockets > 0) uses['adapter.sockets'] = scan.adapterSockets;
      if (Object.keys(uses).length > 0) found[file] = uses;
    }
    expect(found).toEqual({});
  });

  it('the scan sees through spacing, bracket access and destructuring, and skips comments', () => {
    // Pins the scanner itself: the checks above are only as good as what it counts
    const { names, adapterSockets } = scanSource('probe.ts', [
      '// io.in(room).fetchSockets() in a comment',
      '/** fetchSockets() in a doc comment */',
      'const a = io.in(room).fetchSockets ();',
      "const b = io.in(room)['fetchSockets']();",
      'const { fetchSockets } = io.in(room);',
      'const c = io.of("/").adapter.sockets(new Set());',
      "const d = nsp.adapter['sockets'](new Set());",
      'const e = io.allSockets();',
    ].join('\n'));
    expect(names.get('fetchSockets')).toBe(3);
    expect(adapterSockets).toBe(2);
    expect(names.get('allSockets')).toBe(1);
  });

  it('the walk reaches the route files it guards', () => {
    // An empty or misdirected walk would pass the checks above vacuously
    for (const file of ['routes/servers.ts', 'routes/dm.ts', 'routes/admin.ts', ...Object.keys(ALLOWED)]) {
      expect(files).toContain(file);
    }
  });
});
