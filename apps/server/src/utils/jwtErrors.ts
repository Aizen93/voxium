/**
 * What `jwt.verify` throws when it is the TOKEN it refuses — as opposed to
 * what the code around it throws when the user lookup fails (pool exhausted,
 * database down). The two used to be answered alike (401 on REST, 'Invalid
 * token' on the socket handshake), and the client reads that answer as
 * "renew, and sign out when the renewal is refused too": a database blip
 * during a reconnect storm signed everyone out. Only a token jsonwebtoken
 * refused is the client's to repair.
 *
 * Matched on the error NAME, the way jsonwebtoken itself tags its errors:
 * `instanceof jwt.JsonWebTokenError` would be defeated by a test's module
 * mock, and the names are part of the library's documented contract.
 */
const JWT_VERIFY_ERROR_NAMES = new Set(['JsonWebTokenError', 'TokenExpiredError', 'NotBeforeError']);

function errorName(err: unknown): string | undefined {
  const name = (err as { name?: unknown } | null | undefined)?.name;
  return typeof name === 'string' ? name : undefined;
}

/** jsonwebtoken refused the token (malformed, bad signature, expired, not yet valid). */
export function isJwtVerifyError(err: unknown): boolean {
  const name = errorName(err);
  return name !== undefined && JWT_VERIFY_ERROR_NAMES.has(name);
}

/** jsonwebtoken refused the token because its `exp` has passed: the one refusal a refresh repairs. */
export function isJwtExpiredError(err: unknown): boolean {
  return errorName(err) === 'TokenExpiredError';
}
