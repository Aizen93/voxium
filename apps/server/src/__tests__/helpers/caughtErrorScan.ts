/**
 * Two scans over one source text, read through the TypeScript parser (so
 * comments and the contents of strings and templates are never mistaken for
 * code). Both return the 1-based line of each finding.
 *
 * `findUndescribedCaughtLogs`: inside the arguments of a `console.error` or
 * `console.warn` call, a caught value may appear ONLY
 *   (i)  as the single argument of one of the describing functions
 *        (`DESCRIBING_FUNCTIONS`), or
 *   (ii) as a read of `.name` or `.code`, or as the operand of `typeof` or the
 *        left side of `instanceof` (neither prints it).
 * Anything else that names it is a finding (one per call): the bare value,
 * inside an object, a spread, a template, a `+`, `.message`, `.stack`,
 * `String(err)`, `JSON.stringify(err)`, the fallback of an `instanceof` test.
 * A "caught value" is the binding of a `catch (x)` clause, the parameter of
 * the function handed to `.catch(...)` or given as the second argument of
 * `.then(...)`, and any function or arrow parameter named `e`, `err`,
 * `error`, `reason` or `cause` (helper functions, `on('error', (err) => ...)`
 * handlers), inside that function; a parameter annotated `string`, `number`
 * or `boolean` is not one (`reason: string`).
 *
 * The scan checks THAT a caught value is described, not WHICH describing
 * function fits the error: an object-store error handed to
 * `describeCaughtError` passes it (the call sites' own tests hold that rule).
 *
 * What the scan does NOT see: a caught value copied into another variable
 * first (`const msg = err.message; console.warn(msg)`); a logging wrapper
 * function (`logFailure(err)` that logs inside); `console['error']` or an
 * alias of `console.error`; any log call that is not `console.error` /
 * `console.warn`; a caught value held under another parameter name in a
 * helper; a catch that only returns a value.
 *
 * `findSilentCatches`: a `catch` block that is empty or holds only comments,
 * and a function handed to `.catch(...)`, or as the second argument of
 * `.then(...)`, whose body is empty, `undefined`, `null` or `void 0`. Not
 * counted: `.catch(identifier)`.
 */
import ts from 'typescript';

const LOG_METHODS = new Set(['error', 'warn']);
const PARAMETER_NAMES = new Set(['e', 'err', 'error', 'reason', 'cause']);
export const DESCRIBING_FUNCTIONS = new Set([
  'describeCaughtError',
  'describeCaughtErrorWithStack',
  'describeStoreError',
  'errorLabel',
  'describeEmailError',
  'loggableError',
  'describePrismaError',
  'prismaErrorCode',
]);
const SAFE_PROPERTIES = new Set(['name', 'code']);

function parse(source: string): ts.SourceFile {
  return ts.createSourceFile('scan.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function bindingNames(name: ts.BindingName | undefined): string[] {
  if (!name) return [];
  if (ts.isIdentifier(name)) return [name.text];
  const out: string[] = [];
  for (const el of name.elements) {
    if (ts.isBindingElement(el)) out.push(...bindingNames(el.name));
  }
  return out;
}

/** The argument handed to `.catch(f)` or `.then(a, f)` as the rejection handler. */
function rejectionHandler(call: ts.CallExpression): ts.Expression | undefined {
  if (!ts.isPropertyAccessExpression(call.expression)) return undefined;
  const method = call.expression.name.text;
  if (method === 'catch') return call.arguments[0];
  if (method === 'then') return call.arguments[1];
  return undefined;
}

function isFunctionLike(n: ts.Node): n is ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration | ts.MethodDeclaration {
  return ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n);
}

function isPlainValueType(t: ts.TypeNode | undefined): boolean {
  return !!t && (t.kind === ts.SyntaxKind.StringKeyword || t.kind === ts.SyntaxKind.NumberKeyword || t.kind === ts.SyntaxKind.BooleanKeyword);
}

function isLogCall(node: ts.CallExpression): boolean {
  const e = node.expression;
  return ts.isPropertyAccessExpression(e)
    && ts.isIdentifier(e.expression)
    && e.expression.text === 'console'
    && LOG_METHODS.has(e.name.text);
}

/** The node that stands for `n` once parentheses, `as` and `!` are looked through. */
function outward(n: ts.Node): ts.Node {
  let cur = n;
  while (
    cur.parent
    && (ts.isParenthesizedExpression(cur.parent) || ts.isAsExpression(cur.parent) || ts.isNonNullExpression(cur.parent) || ts.isTypeAssertionExpression(cur.parent))
  ) cur = cur.parent;
  return cur;
}

/** True when this reference to a caught value is one of the two allowed forms. */
function allowedReference(id: ts.Identifier): boolean {
  const ref = outward(id);
  const parent = ref.parent;
  if (parent && ts.isTypeOfExpression(parent)) return true;
  if (parent && ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword && parent.left === ref) return true;
  if (parent && ts.isPropertyAccessExpression(parent) && parent.expression === ref) {
    return SAFE_PROPERTIES.has(parent.name.text);
  }
  if (parent && ts.isCallExpression(parent) && parent.arguments.length === 1 && parent.arguments[0] === ref) {
    const callee = parent.expression;
    return ts.isIdentifier(callee) && DESCRIBING_FUNCTIONS.has(callee.text);
  }
  return false;
}

/** True when `arg`'s subtree names a caught value in a way the rule does not allow. */
function namesCaughtValue(arg: ts.Node, caught: Set<string>): boolean {
  let bad = false;
  const visit = (n: ts.Node): void => {
    if (bad) return;
    if (ts.isIdentifier(n) && caught.has(n.text)) {
      const p = n.parent;
      // a property name (`x.err`, `{ err: 1 }` key) is not a reference
      if (p && ts.isPropertyAccessExpression(p) && p.name === n) return;
      if (p && ts.isPropertyAssignment(p) && p.name === n) return;
      if (!allowedReference(n)) bad = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(arg);
  return bad;
}

export function findUndescribedCaughtLogs(source: string): number[] {
  const sf = parse(source);
  const found: number[] = [];
  const visit = (node: ts.Node, caught: Set<string>): void => {
    if (ts.isCatchClause(node)) {
      const scope = node.variableDeclaration
        ? new Set([...caught, ...bindingNames(node.variableDeclaration.name)])
        : caught;
      visit(node.block, scope);
      return;
    }
    if (isFunctionLike(node) && node.body) {
      const own = node.parameters.filter((p) => !isPlainValueType(p.type)).flatMap((p) => bindingNames(p.name)).filter((n) => PARAMETER_NAMES.has(n));
      const inner = own.length > 0 ? new Set([...caught, ...own]) : caught;
      for (const p of node.parameters) if (p.initializer) visit(p.initializer, caught);
      visit(node.body, inner);
      return;
    }
    if (ts.isCallExpression(node)) {
      const handler = rejectionHandler(node);
      if (isLogCall(node) && node.arguments.some((a) => namesCaughtValue(a, caught))) found.push(lineOf(sf, node));
      visit(node.expression, caught);
      for (const arg of node.arguments) {
        if (arg === handler && isFunctionLike(arg) && arg.body) {
          const inner = new Set([...caught, ...arg.parameters.flatMap((p) => bindingNames(p.name))]);
          visit(arg.body, inner);
        } else {
          visit(arg, caught);
        }
      }
      return;
    }
    ts.forEachChild(node, (child) => visit(child, caught));
  };
  visit(sf, new Set());
  return found.sort((a, b) => a - b);
}

function emptyBody(body: ts.ConciseBody): boolean {
  if (ts.isBlock(body)) return body.statements.length === 0;
  if (ts.isIdentifier(body)) return body.text === 'undefined';
  if (body.kind === ts.SyntaxKind.NullKeyword) return true;
  return ts.isVoidExpression(body) && ts.isNumericLiteral(body.expression) && body.expression.text === '0';
}

export function findSilentCatches(source: string): number[] {
  const sf = parse(source);
  const found: number[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCatchClause(node) && node.block.statements.length === 0) found.push(lineOf(sf, node));
    if (ts.isCallExpression(node)) {
      const handler = rejectionHandler(node);
      if (handler && (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler)) && emptyBody(handler.body)) {
        found.push(lineOf(sf, node));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found.sort((a, b) => a - b);
}
