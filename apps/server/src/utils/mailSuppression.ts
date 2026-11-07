import { createHash } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { canonicalizeEmail } from '@voxium/shared';
import { prisma } from './prisma';
import { isJwtVerifyError } from './jwtErrors';

/**
 * The mail suppression list: "Not you? Block Voxium mail to this address".
 *
 * Registration and password reset send mail to whatever address a caller
 * types, and a bot wave types other people's. Rate limits only pace that
 * mail; the person who owns the mailbox needs a way to end it, with nothing
 * more than the e-mail they just received. Every account e-mail therefore
 * carries a link to the block page, and one click there puts the MAILBOX on
 * this list. Every user-facing sender (`utils/email.ts`) refuses a listed
 * mailbox, whatever account, address spelling or caller asks.
 *
 * What is stored is a digest of the mailbox, not the address: the list names
 * people who are mostly NOT users, and a database copy must not become their
 * address book. The digest is an unkeyed SHA-256 under a fixed domain
 * prefix, on purpose: a secret-keyed digest would make every entry
 * unreadable the day `JWT_SECRET` rotates, and nobody would notice until the
 * blocked mailboxes started receiving mail again. A dictionary can confirm
 * that a GUESSED address is on the list, which reveals only that someone at
 * that address asked not to be mailed.
 */

/** Links keep working for a year: a victim may act on an old e-mail. */
export const MAIL_BLOCK_TOKEN_TTL = '365d';
const MAIL_BLOCK_PURPOSE = 'mail-block';
const DIGEST_RE = /^[0-9a-f]{64}$/;

/**
 * The MAILBOX an address delivers to: the canonical form (lowercase, trimmed;
 * gmail-family dots and `+tags` collapsed) with the `+tag` removed for EVERY
 * domain. Sub-addressing (`alice+shop@…`) lands in alice's mailbox at every
 * provider that supports it, and a bot that re-registers `victim+1`,
 * `victim+2`… spells one inbox a thousand ways; alice's block must cover all
 * of them. Nobody can block a mailbox they do not read — the token only ever
 * travels inside mail to that address — so folding tags together takes
 * nothing from anyone.
 */
export function mailboxOf(email: string): string {
  const canonical = canonicalizeEmail(email);
  const at = canonical.lastIndexOf('@');
  if (at === -1) return canonical;
  const local = canonical.slice(0, at);
  const plus = local.indexOf('+');
  return `${plus === -1 ? local : local.slice(0, plus)}@${canonical.slice(at + 1)}`;
}

/** The stored key for an address: SHA-256 of its mailbox under a fixed prefix (hex). */
export function mailboxDigest(email: string): string {
  return createHash('sha256').update(`voxium-mail-suppression:${mailboxOf(email)}`).digest('hex');
}

function secret(): string {
  const value = process.env.JWT_SECRET;
  if (!value) throw new Error('JWT_SECRET is not configured');
  return value;
}

/**
 * The bearer a block link carries: a purpose-tagged HS256 token naming the
 * mailbox DIGEST, never the address. HTTP and socket authentication reject
 * every token with a `purpose`, so it opens nothing but the block page.
 */
export function mailBlockToken(email: string): string {
  return jwt.sign(
    { purpose: MAIL_BLOCK_PURPOSE, m: mailboxDigest(email) },
    secret(),
    { algorithm: 'HS256', expiresIn: MAIL_BLOCK_TOKEN_TTL } as jwt.SignOptions,
  );
}

/** The page a block link opens, on the client (`/mail-block/:token`). */
export function mailBlockUrl(email: string): string {
  const clientUrl = process.env.CLIENT_URL || 'http://localhost:8080';
  return `${clientUrl}/mail-block/${mailBlockToken(email)}`;
}

/**
 * The mailbox digest a block token names, or null for anything jsonwebtoken
 * refuses (signature, expiry, algorithm), a token of another purpose, or a
 * payload whose digest is not a 64-char hex string. Never throws on a bad
 * token: the route answers 400 for null and 500 for anything else.
 */
export function readMailBlockToken(token: string): string | null {
  let payload: unknown;
  try {
    payload = jwt.verify(token, secret(), { algorithms: ['HS256'] });
  } catch (err) {
    if (isJwtVerifyError(err)) return null;
    throw err;
  }
  if (!payload || typeof payload !== 'object') return null;
  const { purpose, m } = payload as { purpose?: unknown; m?: unknown };
  if (purpose !== MAIL_BLOCK_PURPOSE || typeof m !== 'string' || !DIGEST_RE.test(m)) return null;
  return m;
}

/**
 * Whether mail to this address must not be sent. FAILS OPEN on a store error
 * (logged, no address): the senders already fail open on their caps, and a
 * database blip must not silently stop every verification mail; the list is
 * re-read on every send, so the next one honours it again.
 */
export async function isMailSuppressed(email: string): Promise<boolean> {
  try {
    const row = await prisma.mailSuppression.findUnique({
      where: { mailboxHash: mailboxDigest(email) },
      select: { mailboxHash: true },
    });
    return row !== null;
  } catch (err) {
    console.warn('[MailSuppression] Lookup failed (allowing send):', err instanceof Error ? err.message : err);
    return false;
  }
}

/** Whether the mailbox a block token names is on the list. */
export async function isDigestSuppressed(mailboxHash: string): Promise<boolean> {
  const row = await prisma.mailSuppression.findUnique({ where: { mailboxHash }, select: { mailboxHash: true } });
  return row !== null;
}

/** Put the mailbox a block token names on the list. Idempotent. */
export async function suppressDigest(mailboxHash: string): Promise<void> {
  await prisma.mailSuppression.upsert({
    where: { mailboxHash },
    create: { mailboxHash },
    update: {},
  });
}

/** Take the mailbox a block token names off the list. Idempotent. */
export async function unsuppressDigest(mailboxHash: string): Promise<void> {
  await prisma.mailSuppression.deleteMany({ where: { mailboxHash } });
}
