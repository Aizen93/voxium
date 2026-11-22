// A caught error is described before it is logged, and a catch says something.
// This scans the server sources (tests and the generated client excluded) for:
//   an undescribed caught value: inside the arguments of a `console.error` /
//     `console.warn` call, a caught value (a `catch` binding, the parameter of
//     a `.catch(...)` handler or of the second argument of `.then(...)`, any
//     function parameter named e, err, error, reason or cause) may appear only
//     as the single argument of a describing function (`describeCaughtError`,
//     `describeCaughtErrorWithStack`, `describeStoreError`, `errorLabel`,
//     `describeEmailError`, `loggableError`, `describePrismaError`,
//     `prismaErrorCode`), as a read of `.name` or `.code`, or as the operand of
//     `typeof` / the left side of `instanceof`. Printing the error, its
//     message or its stack prints what Prisma puts in a message (the call's
//     arguments), what nodemailer puts in one (the recipient) and what the
//     object store puts in one (the bucket, a host and a port);
//   silent catches: an empty or comment-only `catch` block, and a function
//     handed to `.catch(...)` or as the second argument of `.then(...)` whose
//     body is empty, `undefined`, `null` or `void 0`.
// What the scan does NOT see is written in `helpers/caughtErrorScan.ts`
// (a value copied into another variable first, a logging wrapper, an alias of
// `console.error`). Each list below names a file and the NUMBER of findings in
// it, so a new one in a listed file fails too. The first list is the socket,
// voice, media and boot code, which moves to the helper next and empties it.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { findUndescribedCaughtLogs, findSilentCatches } from '../helpers/caughtErrorScan';

const SRC = join(__dirname, '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== '__tests__' && entry.name !== 'generated') walk(p, out); }
    else if (/\.ts$/.test(entry.name)) out.push(p);
  }
  return out;
}

/** Not yet described: the next batch. Each entry names the NUMBER of calls. */
const NOT_YET_DESCRIBED: Array<{ file: string; count: number; reason: string }> = [
  { file: 'index.ts', count: 9, reason: 'boot code, moves to the helper with the socket and voice code' },
  { file: 'mediasoup/mediasoupManager.ts', count: 4, reason: 'media code, moves to the helper with the socket and voice code' },
  { file: 'utils/channelVisibilityRooms.ts', count: 8, reason: 'room resync, moves to the helper with the socket and voice code' },
  { file: 'utils/redis.ts', count: 10, reason: 'Redis plumbing, moves to the helper with the socket and voice code' },
  { file: 'utils/registrationHygiene.ts', count: 11, reason: 'nightly sweep, moves to the helper with the socket and voice code' },
  { file: 'websocket/adminMetrics.ts', count: 1, reason: 'socket code, moves to the helper next' },
  { file: 'websocket/adminSubscriptions.ts', count: 1, reason: 'socket code, moves to the helper next' },
  { file: 'websocket/annotationHandler.ts', count: 2, reason: 'socket code, moves to the helper next' },
  { file: 'websocket/dmVoiceHandler.ts', count: 8, reason: 'socket code, moves to the helper next' },
  { file: 'websocket/latestStateLimit.ts', count: 1, reason: 'socket code, moves to the helper next' },
  { file: 'websocket/socketServer.ts', count: 16, reason: 'socket code, moves to the helper next' },
  { file: 'websocket/voiceCluster.ts', count: 6, reason: 'socket code, moves to the helper next' },
  { file: 'websocket/voiceHandler.ts', count: 33, reason: 'socket code, moves to the helper next' },
  { file: 'websocket/voiceRelay.ts', count: 6, reason: 'socket code, moves to the helper next' },
];

const SILENT_ON_PURPOSE: Array<{ file: string; count: number; reason: string }> = [
  { file: 'mediasoup/mediasoupManager.ts', count: 1, reason: 'a rejection that is surfaced to the callers awaiting the same promise' },
  { file: 'middleware/rateLimiter.ts', count: 2, reason: 'a config message that does not parse is ignored (any publisher can send one), and a bearer that does not verify is anonymous for the limiter and refused by authenticate' },
  { file: 'services/authService.ts', count: 1, reason: 'an invalid or expired trusted-device token means the second factor is required: the sign-in goes on' },
  { file: 'utils/s3.ts', count: 1, reason: 'a bucket with no encryption configuration answers with an error on most stores; the call after it decides and logs' },
];

function scan(finder: (src: string) => number[]): Map<string, number> {
  const found = new Map<string, number>();
  for (const file of walk(SRC)) {
    const n = finder(readFileSync(file, 'utf8')).length;
    if (n > 0) found.set(relative(SRC, file).split(/[\\/]/).join('/'), n);
  }
  return found;
}

const asObject = (m: Map<string, number>) => Object.fromEntries([...m].sort(([a], [b]) => (a < b ? -1 : 1)));
const listed = (l: Array<{ file: string; count: number }>) => asObject(new Map(l.map((e) => [e.file, e.count])));

describe('server sources: a caught error is described before it is logged', () => {
  it('finds undescribed caught values only in the listed files, count by count', () => {
    expect(asObject(scan(findUndescribedCaughtLogs))).toEqual(listed(NOT_YET_DESCRIBED));
  });

  it('lists each file once, with a reason', () => {
    expect(new Set(NOT_YET_DESCRIBED.map((e) => e.file)).size).toBe(NOT_YET_DESCRIBED.length);
    for (const e of NOT_YET_DESCRIBED) expect(e.reason.length).toBeGreaterThan(10);
  });
});

describe('server sources: no silent catches outside the listed ones', () => {
  it('finds exactly the listed ones, file by file and count by count', () => {
    expect(asObject(scan(findSilentCatches))).toEqual(listed(SILENT_ON_PURPOSE));
  });

  it('lists each file once, with a reason', () => {
    expect(new Set(SILENT_ON_PURPOSE.map((e) => e.file)).size).toBe(SILENT_ON_PURPOSE.length);
    for (const e of SILENT_ON_PURPOSE) expect(e.reason.length).toBeGreaterThan(10);
  });
});

describe('the undescribed-value scanner, on in-memory sources', () => {
  const count = (src: string) => findUndescribedCaughtLogs(src).length;

  it.each([
    ['the binding as an argument', "try { x(); } catch (err) { console.error('a', err); }"],
    ['console.warn', "try { x(); } catch (err) { console.warn('a', err); }"],
    ['the binding in an object', "try { x(); } catch (err) { console.error('a', { err }); }"],
    ['the binding as a property value', "try { x(); } catch (e) { console.warn('a', { error: e }); }"],
    ['the binding in a template', 'try { x(); } catch (err) { console.warn(`a ${err}`); }'],
    ['a concatenation', "try { x(); } catch (err) { console.warn('a ' + err); }"],
    ['the fallback of an instanceof test', "try { x(); } catch (err) { console.warn('a', err instanceof Error ? err.message : err); }"],
    ['.message', "try { x(); } catch (err) { console.warn('a', err.message); }"],
    ['.stack', "try { x(); } catch (err) { console.error('a', err.stack); }"],
    ['an optional .message', "try { x(); } catch (err) { console.warn('a', err?.message); }"],
    ['String(err)', "try { x(); } catch (err) { console.warn('a', String(err)); }"],
    ['JSON.stringify(err)', "try { x(); } catch (err) { console.warn('a', JSON.stringify(err)); }"],
    ['a describing function with a second argument', "try { x(); } catch (err) { console.warn('a', describeCaughtError(err, 1)); }"],
    ['a spread', "try { x(); } catch (err) { console.error('a', ...[err]); }"],
    ['a .catch arrow', "p.catch((err) => console.warn('a', err));"],
    ['a .catch arrow with a block', "p.catch((e) => { console.error('a', e); });"],
    ['a .catch arrow with .message', "p.catch((x) => console.warn('a', x.message));"],
    ['a .then rejection handler', "p.then(ok, (e) => console.warn('a', e));"],
    ['a function expression handler', "p.catch(function (e) { console.warn('a', e); });"],
    ['a nested catch', "try { a(); } catch { try { b(); } catch (inner) { console.error('a', inner); } }"],
    ['a helper function parameter named err', "function log(step: string, err: unknown) { console.error(step, err.message); }"],
    ['an arrow parameter named error', "const log = (error: unknown) => console.warn('a', error);"],
    ['an event handler parameter', "emitter.on('error', (err) => { console.error('a', err); });"],
    ['a parameter named reason', "function f(reason: unknown) { console.warn('a', reason); }"],
    ['a parameter named cause', "function f(cause: unknown) { console.warn('a', cause); }"],
    ['a parameter of an async method', "class A { async m(err: unknown) { console.warn('a', err); } }"],
  ])('finds %s', (_name, src) => {
    expect(count(src)).toBe(1);
  });

  it.each([
    ['describeCaughtError', "try { x(); } catch (err) { console.warn('a', describeCaughtError(err)); }"],
    ['describeCaughtErrorWithStack', "try { x(); } catch (err) { console.error('a', describeCaughtErrorWithStack(err)); }"],
    ['describeStoreError', "p.catch((err) => console.warn(`a (${describeStoreError(err)})`));"],
    ['describeEmailError', "try { x(); } catch (err) { console.warn(`a (${describeEmailError(err)})`); }"],
    ['loggableError in a wrapper expression', "try { x(); } catch (err) { console.warn('a', loggableError(err as Error)); }"],
    ['describePrismaError', "try { x(); } catch (err) { console.warn('a', describePrismaError(err)); }"],
    ['prismaErrorCode', "try { x(); } catch (err) { console.warn('a', prismaErrorCode(err) ?? 'no code'); }"],
    ['a name read', "try { x(); } catch (err) { console.warn('a', err.name); }"],
    ['a code read', "try { x(); } catch (err) { console.warn('a', (err as { code?: string }).code); }"],
    ['typeof', "try { x(); } catch (err) { console.warn('a', typeof err); }"],
    ['a name-only instanceof test', "try { x(); } catch (err) { console.warn('a', err instanceof Error ? err.name : typeof err); }"],
    ['a parameter typed string', "function f(reason: string) { console.warn('a', reason); }"],
    ['a parameter that is not named like an error', "function f(label: unknown) { console.warn('a', label); }"],
    ['a variable that is not caught', "const err = 1; console.warn('a', err);"],
    ['a binding outside its catch', "try { x(); } catch (err) { y(); } console.warn('a', err);"],
    ['console.log', "try { x(); } catch (err) { console.log('a', err); }"],
    ['a binding named inside a string', "try { x(); } catch (err) { console.warn('a err b'); }"],
    ['a binding named in a comment', "try { x(); } catch (err) { // console.warn('a', err);\n }"],
    ['a property that is only named like the binding', "try { x(); } catch (err) { console.warn('a', { err: 1 }, o.err); }"],
    // the limits of the scan, written down: these are NOT seen
    ['a value copied into another variable first (a limit)', "try { x(); } catch (err) { const msg = err.message; console.warn('a', msg); }"],
    ['a logging wrapper (a limit)', "try { x(); } catch (err) { logFailure('a', err); }"],
    ["console['error'] (a limit)", "try { x(); } catch (err) { console['error']('a', err); }"],
    ['an alias of console.error (a limit)', "const log = console.error; try { x(); } catch (err) { log('a', err); }"],
  ])('does not find %s', (_name, src) => {
    expect(count(src)).toBe(0);
  });

  it('reports the line of the call', () => {
    expect(findUndescribedCaughtLogs("a();\ntry { x(); } catch (err) {\n  console.error('a', err);\n}")).toEqual([3]);
  });

  it('counts one finding per call', () => {
    expect(count("try { x(); } catch (err) { console.warn('a', err, err.message, `${err}`); }")).toBe(1);
  });
});

describe('the silent-catch scanner, on in-memory sources', () => {
  const count = (src: string) => findSilentCatches(src).length;

  it.each([
    ['catch {}', 'try { x(); } catch {}'],
    ['catch (e) {}', 'try { x(); } catch (e) {}'],
    ['an empty multi-line catch', 'try { x(); } catch {\n}'],
    ['a comment-only catch with a binding', 'try { x(); } catch (_err) {\n  // ignore\n}'],
    ['a block-comment-only catch', 'try { x(); } catch { /* ignore */ }'],
    ['.catch(() => {})', 'p.catch(() => {});'],
    ['.catch with a parameter and an empty body', 'p.catch((_e) => {});'],
    ['.catch(() => null)', 'p.catch(() => null);'],
    ['.catch(() => undefined)', 'p.catch(() => undefined);'],
    ['.catch(() => void 0)', 'p.catch(() => void 0);'],
    ['.catch(async () => {})', 'p.catch(async () => {});'],
    ['an empty function expression handler', 'p.catch(function () {});'],
    ['an empty second argument of .then', 'p.then(ok, () => {});'],
    ['a .then second argument that is null', 'p.then(ok, () => null);'],
  ])('finds %s', (_name, src) => {
    expect(count(src)).toBe(1);
  });

  it.each([
    ['a catch that logs', "try { x(); } catch (e) { console.warn('a', describeCaughtError(e)); }"],
    ['a catch that only returns', 'function f() { try { x(); } catch { return null; } }'],
    ['.catch(handler)', 'p.catch(handler);'],
    ['.catch with a logging arrow', "p.catch((e) => console.warn('a', describeCaughtError(e)));"],
    ['a .then whose first argument is empty', 'p.then(() => {});'],
    ['a .then whose second argument logs', "p.then(ok, (e) => console.warn('a', describeCaughtError(e)));"],
    ['"catch {}" inside a string', "const s = 'try { x(); } catch {}';"],
    ['"catch {}" inside a comment', '// try { x(); } catch {}\nconst a = 1;'],
    ['"catch {}" inside a template', 'const s = `catch {}`;'],
  ])('does not find %s', (_name, src) => {
    expect(count(src)).toBe(0);
  });

  it('reports the line of the catch', () => {
    expect(findSilentCatches('a();\ntry { x(); }\ncatch {}')).toEqual([3]);
  });
});
