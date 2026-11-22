import { describeEmailError } from './email';

/**
 * How a caught error is written to a log line. Never the error object: its
 * own properties print too, and some carry personal data (a nodemailer error
 * holds the recipient address in `.envelope`). A new file instead of
 * `utils/errors.ts`, which stays free of imports: describing an SMTP error
 * needs `describeEmailError`, and `errors.ts` is loaded by everything.
 */

export interface LoggableError {
  name: string | undefined;
  code: string | undefined;
  message: string;
  stack: string | undefined;
}

/**
 * The frame lines of an error's stack, taken from AFTER the message the
 * engine repeats at its top: a message that holds a line looking like a frame
 * (`    at fake (x.js:1:1)`) is part of that header and never counts. When the
 * stack begins with `name: message` (as V8 builds it) that header is cut off;
 * otherwise as many leading lines are skipped as the message has. Each frame
 * line is written without a trailing carriage return and with any control
 * character shown as an escape (a stack can be set by hand).
 */
export function framesOf(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const f = err as { name?: unknown; message?: unknown; stack?: unknown };
  if (typeof f.stack !== 'string') return undefined;
  const message = typeof f.message === 'string' ? f.message : '';
  const name = typeof f.name === 'string' ? f.name : '';
  const header = message === '' ? name : `${name}: ${message}`;
  let lines: string[];
  if (f.stack.startsWith(header)) {
    // what follows the header's last line is empty or the start of the frames
    lines = f.stack.slice(header.length).split('\n').slice(1);
  } else {
    lines = f.stack.split('\n').slice(message.split('\n').length);
  }
  return lines
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => /^\s+at \S/.test(line))
    .map(oneLine)
    .join('\n');
}

/**
 * Prisma errors whose message (and so the first lines of the stack) prints
 * the call: its arguments verbatim, `where` values, `data` values (a password
 * hash, an e-mail address) and the source lines around the call. A panic's
 * message comes from a renderer nobody here has traced, so it is treated the
 * same way: name only, never its text. So is an initialisation error, whose
 * message names the database host.
 */
const PRISMA_ARGUMENT_ERRORS = new Set([
  'PrismaClientValidationError',
  'PrismaClientKnownRequestError',
  'PrismaClientUnknownRequestError',
  'PrismaClientRustPanicError',
  // its message names the database host and port
  'PrismaClientInitializationError',
]);

/**
 * A Prisma error described without its arguments: the operation from the
 * message's first line (`Invalid \`prisma.user.update()\` invocation`, only
 * identifier characters kept) and the model Prisma names in `meta.modelName`.
 */
export function describePrismaError(message: unknown, meta: unknown): string {
  const call = typeof message === 'string' ? /Invalid `[\w$]+\.([\w$.]+)\(\)` invocation/.exec(message)?.[1] : undefined;
  const modelName = typeof meta === 'object' && meta !== null && typeof (meta as { modelName?: unknown }).modelName === 'string'
    ? (meta as { modelName: string }).modelName
    : undefined;
  const parts = [
    call ? `${call}()` : undefined,
    modelName && /^\w+$/.test(modelName) ? `model ${modelName}` : undefined,
  ].filter(Boolean);
  return parts.length > 0 ? `${parts.join(', ')} failed (arguments not logged)` : 'Prisma query failed (arguments not logged)';
}

/**
 * The strings an unexpected error is logged with, read without touching
 * anything else on it: its name, a string `code` (ECONNREFUSED, P2025…), its
 * message and its stack. An SMTP error (nodemailer sets `command` or
 * `responseCode`) quotes the server's reply in its message, and a refused
 * recipient's reply names the address (`550 … <addr>`): it is described by
 * describeEmailError (its codes) instead, and its stack keeps only the frames,
 * whose first line would repeat that message. A Prisma validation or request
 * error prints the call's arguments in both: it is described by its name,
 * code, operation and model (describePrismaError), with the frames only.
 */
export function loggableError(err: unknown): LoggableError {
  const fields = typeof err === 'object' && err !== null
    ? err as { name?: unknown; code?: unknown; message?: unknown; stack?: unknown; command?: unknown; responseCode?: unknown; meta?: unknown }
    : {};
  const name = typeof fields.name === 'string' ? fields.name : undefined;
  const code = typeof fields.code === 'string' ? fields.code : undefined;
  const stack = typeof fields.stack === 'string' ? fields.stack : undefined;
  const framesOnly = framesOf(err);
  // nodemailer's own shapes only: a `command` string or a `responseCode` number
  if (typeof fields.command === 'string' || typeof fields.responseCode === 'number') {
    return { name, code, message: describeEmailError(err), stack: framesOnly };
  }
  if (name !== undefined && PRISMA_ARGUMENT_ERRORS.has(name)) {
    const described = name === 'PrismaClientInitializationError'
      ? 'Prisma client could not connect or initialise (message not logged)'
      : describePrismaError(fields.message, fields.meta);
    return { name, code, message: described, stack: framesOnly };
  }
  const message = typeof fields.message === 'string'
    ? fields.message
    : typeof err === 'string' ? err : `Non-error value thrown (${err === null ? 'null' : typeof err})`;
  return { name, code, message, stack };
}

/**
 * Everything that can break or disturb a log line, written as visible
 * characters: the line breaks (LF, CR, NEL, U+2028, U+2029), vertical tab,
 * form feed, escape, DEL and the other C0 controls. A tab stays.
 */
// eslint-disable-next-line no-control-regex -- the control characters are the point
const DISTURBING_RE = new RegExp('[\\u0000-\\u0008\\u000A-\\u001F\\u007F\\u0085\\u2028\\u2029]', 'g');

function oneLine(text: string): string {
  return text.replace(DISTURBING_RE, (c) => {
    if (c === '\n') return '\\n';
    if (c === '\r') return '\\r';
    return '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0');
  });
}

/** How many inner errors of an AggregateError are named before the rest is counted. */
const AGGREGATE_NAMED_MAX = 3;

/** A name or a code is an identifier: anything longer is cut, so a label stays a label. */
const LABEL_PART_MAX = 64;
const labelPart = (part: string): string => (part.length > LABEL_PART_MAX ? `${part.slice(0, LABEL_PART_MAX)}...` : part);

/** `Name [CODE]`, the identity of an error without its text. */
function labelOf(name: string | undefined, code: string | undefined): string {
  return oneLine(`${labelPart(name ?? 'Error')}${code ? ` [${labelPart(code)}]` : ''}`);
}

/** `Name [CODE]` of a caught error, escaped for a log line; never its message. */
export function errorLabel(err: unknown): string {
  const { name, code } = loggableError(err);
  return labelOf(name, code);
}

/**
 * What stands in for an empty message (an AggregateError from a failed
 * connect has one): the error's name and string code and, for an
 * AggregateError, the names and codes of its first inner errors, then a count.
 */
function emptyMessageFallback(err: unknown, name: string | undefined, code: string | undefined): string {
  const inner = typeof err === 'object' && err !== null ? (err as { errors?: unknown }).errors : undefined;
  if (!Array.isArray(inner) || inner.length === 0) return labelOf(name, code);
  const named = inner.slice(0, AGGREGATE_NAMED_MAX).map((e) => {
    const l = loggableError(e);
    return labelOf(l.name, l.code);
  });
  const more = inner.length > AGGREGATE_NAMED_MAX ? `, and ${inner.length - AGGREGATE_NAMED_MAX} more` : '';
  return `${labelOf(name, code)} of ${named.join(', ')}${more}`;
}

function messageOf(err: unknown): string {
  const { name, code, message } = loggableError(err);
  return oneLine(message.trim() === '' ? emptyMessageFallback(err, name, code) : message);
}

/**
 * The text of a caught error for a log line, in the place of `err.message`
 * or `err instanceof Error ? err.message : err`: the message of an ordinary
 * error, a string as it is, the described form of a Prisma or SMTP error, and
 * the type of anything else (an object is never printed). An empty message is
 * replaced by the name and code (and an AggregateError's inner ones), and a
 * line break or control character in the text or the label is shown as an
 * escape (\n, \r, \u001b), never written.
 */
export function describeCaughtError(err: unknown): string {
  return messageOf(err);
}

/**
 * The same with the name, the code and the stack, in the place of passing the
 * error itself to the log (which prints its own properties too): `Name
 * [CODE]: message` and the frames below it, each on a line of its own.
 */
export function describeCaughtErrorWithStack(err: unknown): string {
  const { name, code } = loggableError(err);
  // the frames only, from after the message the stack repeats at its top
  const frames = framesOf(err);
  const head = `${labelOf(name, code)}: ${messageOf(err)}`;
  return frames ? `${head}\n${frames}` : head;
}

/** An error name or code: an identifier, never a sentence. */
const ERROR_TOKEN_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

/**
 * An error of the store or the network as its name, code and HTTP status.
 * Never its message: a network error's message names the endpoint's host and
 * port (`connect ECONNREFUSED host:port`, `getaddrinfo ENOTFOUND host`), and a
 * store's message can name the bucket. `fetch` hides the system error's code
 * in `cause`, which is read the same way, and the SDK's HTTP handler wraps an
 * abort as an `AbortError` whose `cause` is the signal's reason: that name is
 * appended as `cause <name>` (a timeout reads `AbortError, cause TimeoutError`).
 * A cause that is a plain `Error` says nothing and is left out.
 */
export function describeStoreError(err: unknown): string {
  const e = (err ?? {}) as {
    name?: unknown; code?: unknown; Code?: unknown;
    cause?: { code?: unknown; name?: unknown } | null;
    $metadata?: { httpStatusCode?: unknown };
  };
  const parts: string[] = [];
  for (const token of [e.name, e.code, e.Code, e.cause?.code]) {
    if (typeof token === 'string' && ERROR_TOKEN_RE.test(token) && !parts.includes(token)) parts.push(token);
  }
  const causeName = e.cause?.name;
  if (typeof causeName === 'string' && causeName !== 'Error' && ERROR_TOKEN_RE.test(causeName) && !parts.includes(causeName)) parts.push(`cause ${causeName}`);
  const status = e.$metadata?.httpStatusCode;
  if (typeof status === 'number' && Number.isInteger(status)) parts.push(`HTTP ${status}`);
  return parts.length > 0 ? parts.join(', ') : 'unknown error';
}

/**
 * Runs an object-store call and rethrows a failure as an error whose text is
 * safe to log and to mail (`describeStoreError`): the store's own message can
 * name the bucket, a host and a port.
 */
export async function storeCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    throw new Error(`The object store call failed (${describeStoreError(err)})`, { cause: err });
  }
}
