import crypto from 'crypto';

/**
 * Opaque, SIGNED pagination cursors, the shape discoveryCursor.ts introduced:
 *
 *   base64url(JSON) "." base64url(HMAC-SHA256(JSON))
 *
 * A client hands a cursor back verbatim and cannot edit it into a different
 * query or an arbitrary position. Each listing signs under its own SCOPE so a
 * cursor issued for one cannot be replayed against another, and the key
 * derives from JWT_SECRET (boot already refuses to start without it — no
 * second secret to rotate).
 */
const CURSOR_MAX_LEN = 512;
const TOKEN_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

function cursorKey(scope: string): Buffer {
  return crypto.createHash('sha256').update(`voxium-cursor:${scope}:${process.env.JWT_SECRET!}`).digest();
}

function sign(scope: string, payload: string): string {
  return crypto.createHmac('sha256', cursorKey(scope)).update(payload).digest('base64url');
}

export function encodeSignedCursor(scope: string, cursor: object): string {
  const payload = Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
  return `${payload}.${sign(scope, payload)}`;
}

/**
 * The verified, parsed payload of a cursor this server issued under `scope`,
 * or null for anything else: malformed, bad signature, tampered, borrowed
 * from another listing. The caller validates the fields (a null from there
 * is a 400 at the route — never a silent first page).
 */
export function decodeSignedCursor(scope: string, token: unknown): Record<string, unknown> | null {
  // Charset first: only base64url and one dot can be ours, and it keeps the
  // signature compare on equal BYTE lengths (a multi-byte character has the
  // same string length as an ASCII one and would make timingSafeEqual throw).
  if (typeof token !== 'string' || token.length === 0 || token.length > CURSOR_MAX_LEN || !TOKEN_RE.test(token)) return null;
  const dot = token.indexOf('.');
  const payload = token.slice(0, dot);
  const mac = Buffer.from(token.slice(dot + 1), 'utf8');
  const good = Buffer.from(sign(scope, payload), 'utf8');
  if (mac.length !== good.length) return null;
  if (!crypto.timingSafeEqual(mac, good)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}
