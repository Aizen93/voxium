import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import geoip from 'geoip-lite';
import { prisma } from '../utils/prisma';
import type { RegistrationConsent, UserRole } from '@voxium/shared';
import {
  SIGNUP, USERNAME_TAKEN_MESSAGE, SIGNUP_CODE_INVALID_MESSAGE, SIGNUP_EMAIL_REGISTERED_MESSAGE,
  validateEmail, validatePassword, validateUsername, canonicalizeEmail, isDisposableEmailDomain,
  emailDomain, isCommonEmailProvider,
} from '@voxium/shared';
import { BadRequestError, ConflictError, ForbiddenError } from '../utils/errors';
import { sanitizeText } from '../utils/sanitize';
import {
  sendSignupCodeEmail, sendSignupExistingAccountEmail, describeEmailError, MailSuppressedError,
} from '../utils/email';
import { isMailSuppressed, mailboxDigest } from '../utils/mailSuppression';
import { getDomainRegistrationCount, countDomainRegistration, domainRegistrationCap, normalizeIp } from '../middleware/rateLimiter';
import { deleteUserAccount } from '../utils/accountDeletion';
import { generateTokens, CONSENT_SELECT, withConsentFlag } from './authService';

/*
 * Verify-first registration.
 *
 * startRegistration never creates an account and never says anything about the
 * address: a new address, one that already has an account, a blocked mailbox, a
 * capped domain and a mailbox that already got its sign-up mails all get the
 * same 202. The costly work is the same on every branch (bcrypt, the user and
 * suppression lookups, the domain count of a non-common domain, one pending
 * row); what still differs is the ledger write, skipped where nothing would be
 * mailed, and the send, which runs after the answer. Only the first kind is
 * mailed a code (or, for an existing verified account, a "you already have an
 * account" notice), and only while the mailbox's ledger allows it.
 *
 * completeRegistration creates the account when the code comes back, which
 * proves the person reads the mailbox. A code, never a link: mail gateways open
 * links to scan them.
 */

const MINUTE = 60_000;

export interface SignupStartResult {
  /** what the client sends back with the code; a decoy for branches that mailed nothing */
  pendingId: string;
  /** seconds before a resend may be asked for */
  resendAfterSeconds: number;
}

function newPendingId(): string {
  return crypto.randomBytes(16).toString('base64url');
}

function newCode(): string {
  return crypto.randomInt(0, 10 ** SIGNUP.CODE_LENGTH).toString().padStart(SIGNUP.CODE_LENGTH, '0');
}

/**
 * The stored form of a code. Unkeyed on purpose: six digits cannot be sized
 * against an offline guess whatever the hash, so the real bound is the attempt
 * cap and the short lifetime; binding the id in stops one hash matching across
 * rows.
 */
export function signupCodeHash(pendingId: string, code: string): string {
  return crypto.createHash('sha256').update(`${pendingId}:${code}`).digest('hex');
}

function sameHash(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/**
 * Take one slot of the mailbox's sign-up mail ledger. ONE statement, written
 * BEFORE the send and never given back: parallel starts cannot mail one inbox
 * twice, and a failed send still counts (erring toward fewer mails). Fails
 * CLOSED (no mail) on a store error: the caller answers the same either way.
 *
 * `max` is the count the window may hold BEFORE this mail: the codes share
 * LEDGER_MAX_MAILS, the existing-account notice asks LEDGER_MAX_NOTICES (one
 * per window, and only while the window has sent nothing else).
 */
export async function claimSignupMailSlot(mailboxHash: string, max: number = SIGNUP.LEDGER_MAX_MAILS): Promise<boolean> {
  try {
    const rows = await prisma.$queryRaw<Array<{ sent: number }>>`
      INSERT INTO signup_mail_ledger (mailbox_hash, window_start_at, sent)
      VALUES (${mailboxHash}, (now() AT TIME ZONE 'UTC'), 1)
      ON CONFLICT (mailbox_hash) DO UPDATE SET
        window_start_at = CASE
          WHEN signup_mail_ledger.window_start_at < (now() AT TIME ZONE 'UTC') - make_interval(days => ${SIGNUP.LEDGER_WINDOW_DAYS})
          THEN (now() AT TIME ZONE 'UTC') ELSE signup_mail_ledger.window_start_at END,
        sent = CASE
          WHEN signup_mail_ledger.window_start_at < (now() AT TIME ZONE 'UTC') - make_interval(days => ${SIGNUP.LEDGER_WINDOW_DAYS})
          THEN 1 ELSE signup_mail_ledger.sent + 1 END
      WHERE signup_mail_ledger.window_start_at < (now() AT TIME ZONE 'UTC') - make_interval(days => ${SIGNUP.LEDGER_WINDOW_DAYS})
         OR signup_mail_ledger.sent < ${max}
      RETURNING sent`;
    return rows.length > 0;
  } catch (err) {
    console.error('[Signup] Mail ledger write failed (no mail sent):', err instanceof Error ? err.message : err);
    return false;
  }
}

type StartBranch = 'code' | 'existing' | 'silent';

export async function startRegistration(
  username: string,
  emailInput: string,
  password: string,
  displayName: string | undefined,
  rawIp: string | undefined,
  consent: RegistrationConsent | undefined,
): Promise<SignupStartResult> {
  if (!consent || consent.acceptTerms !== true || consent.acceptPrivacy !== true) {
    throw new BadRequestError('You must accept the Terms of Service and the Privacy Policy');
  }
  const consentedAt = new Date();
  const email = emailInput.toLowerCase().trim();
  const ip = rawIp ? normalizeIp(rawIp) : undefined;

  const usernameErr = validateUsername(username);
  if (usernameErr) throw new BadRequestError(usernameErr);
  const emailErr = validateEmail(email);
  if (emailErr) throw new BadRequestError(emailErr);
  const passwordErr = validatePassword(password);
  if (passwordErr) throw new BadRequestError(passwordErr);

  if (ip) {
    const ipBan = await prisma.ipBan.findUnique({ where: { ip } });
    if (ipBan) throw new ForbiddenError(ipBan.reason ? `Account banned: ${ipBan.reason}` : 'Your account has been banned');
  }

  // Usernames are public (profiles, mentions), so a taken one may say so. It is
  // the ONLY synchronous conflict: nothing here may depend on the e-mail.
  const nameTaken = await prisma.user.findFirst({
    where: { username: { equals: username, mode: 'insensitive' } },
    select: { id: true },
  });
  if (nameTaken) throw new ConflictError(USERNAME_TAKEN_MESSAGE);

  // From here every branch pays bcrypt, the lookups and one row.
  const passwordHash = await bcrypt.hash(password, 12);
  const emailCanonical = canonicalizeEmail(email);
  const mailbox = mailboxDigest(email);

  // Every branch runs the same lookups, whatever it decides (the domain count
  // too, for every non-common domain, though only the code branch reads it).
  const holder = await prisma.user.findFirst({
    where: { OR: [{ email }, { emailCanonical }] },
    select: { emailVerified: true },
  });
  const suppressed = await isMailSuppressed(email);
  const domain = emailDomain(email);
  const domainCapped = !isCommonEmailProvider(domain)
    && (await getDomainRegistrationCount(domain)) >= domainRegistrationCap();

  let branch: StartBranch = 'code';
  // A verified account is told someone tried; an unverified legacy row is
  // superseded at completion (the code proves the mailbox, the row does not).
  if (holder?.emailVerified) branch = 'existing';
  // A disposable domain is refused the same way a blocked mailbox is: silently,
  // or the blocklist would become a list anyone can probe.
  if (isDisposableEmailDomain(email) || suppressed) branch = 'silent';
  if (branch === 'code' && domainCapped) branch = 'silent';
  if (branch === 'code' && !(await claimSignupMailSlot(mailbox))) branch = 'silent';
  if (branch === 'existing' && !(await claimSignupMailSlot(mailbox, SIGNUP.LEDGER_MAX_NOTICES))) branch = 'silent';

  const pendingId = newPendingId();
  const code = newCode();
  const now = Date.now();
  await prisma.pendingRegistration.create({
    data: {
      id: pendingId,
      username,
      email,
      emailCanonical,
      displayName: sanitizeText(displayName) || username,
      passwordHash,
      // Branches that mail no code store a hash of a code nobody was given
      codeHash: signupCodeHash(pendingId, branch === 'code' ? code : newCode() + crypto.randomBytes(8).toString('hex')),
      codeExpiresAt: new Date(now + SIGNUP.CODE_TTL_MINUTES * MINUTE),
      // lastSentAt marks a row that really mailed a code: only those can resend
      lastSentAt: branch === 'code' ? new Date(now) : null,
      termsAcceptedAt: consentedAt,
      privacyAcceptedAt: consentedAt,
      ip: ip ?? null,
      expiresAt: new Date(now + SIGNUP.PENDING_TTL_MINUTES * MINUTE),
    },
  });

  // Fire-and-forget: the answer must not wait on (or reveal) the transport.
  if (branch === 'code') {
    sendSignupCodeEmail(email, code, SIGNUP.CODE_TTL_MINUTES).catch((err) => logSendFailure('code', err));
  } else if (branch === 'existing') {
    sendSignupExistingAccountEmail(email).catch((err) => logSendFailure('existing-account notice', err));
  }

  return { pendingId, resendAfterSeconds: SIGNUP.RESEND_AFTER_SECONDS };
}

function logSendFailure(kind: string, err: unknown): void {
  if (err instanceof MailSuppressedError) {
    console.warn(`[Signup] ${kind} mail skipped: the mailbox blocked Voxium mail`);
    return;
  }
  console.error(`[Signup] Failed to send the ${kind} mail:`, describeEmailError(err));
}

/**
 * A second code for the same pending registration: once, no earlier than
 * RESEND_AFTER_SECONDS after the first, and only while the mailbox's ledger
 * allows it. Answers the same whatever happened, and BEFORE any of it happens:
 * the lookup, the claims and the send run after the answer (fire-and-forget,
 * failures logged), so the answer never depends on the row.
 */
export async function resendRegistrationCode(pendingId: string): Promise<SignupStartResult> {
  const answer: SignupStartResult = { pendingId, resendAfterSeconds: SIGNUP.RESEND_AFTER_SECONDS };
  if (typeof pendingId !== 'string' || pendingId.length > 64) return answer;

  resendInBackground(pendingId).catch((err) => {
    console.error('[Signup] Code resend failed:', err instanceof Error ? err.message : err);
  });
  return answer;
}

async function resendInBackground(pendingId: string): Promise<void> {
  const now = Date.now();
  const row = await prisma.pendingRegistration.findUnique({ where: { id: pendingId } });
  if (
    !row
    || !row.lastSentAt // a row that never mailed a code never mails one
    || row.expiresAt.getTime() <= now
    || row.resends >= SIGNUP.MAX_RESENDS
    || row.attempts >= SIGNUP.MAX_CODE_ATTEMPTS
    || now - row.lastSentAt.getTime() < SIGNUP.RESEND_AFTER_SECONDS * 1000
  ) {
    return;
  }
  if (await isMailSuppressed(row.email)) return;

  // Claim the resend on the row first (conditional update), so two parallel
  // resends cannot both pass the checks above.
  const claimed = await prisma.pendingRegistration.updateMany({
    where: { id: pendingId, resends: row.resends, lastSentAt: row.lastSentAt },
    data: { resends: { increment: 1 }, lastSentAt: new Date(now) },
  });
  if (claimed.count !== 1) return;
  if (!(await claimSignupMailSlot(mailboxDigest(row.email)))) return;

  const code = newCode();
  await prisma.pendingRegistration.update({
    where: { id: pendingId },
    data: { codeHash: signupCodeHash(pendingId, code), codeExpiresAt: new Date(now + SIGNUP.CODE_TTL_MINUTES * MINUTE) },
  });
  sendSignupCodeEmail(row.email, code, SIGNUP.CODE_TTL_MINUTES).catch((err) => logSendFailure('code', err));
}

/**
 * What a P2002 says it violated, as text to match a column or index name in.
 * Prisma 7 behind a driver adapter (adapter-pg) never sets `meta.target`: the
 * index is reported under `meta.driverAdapterError.cause.constraint`
 * (`{ index }` or `{ fields }`). Both places are read.
 */
function uniqueViolationTarget(err: unknown): string {
  const meta = (err as { meta?: { target?: unknown; driverAdapterError?: { cause?: { constraint?: unknown } } } }).meta;
  try {
    return JSON.stringify([meta?.target ?? null, meta?.driverAdapterError?.cause?.constraint ?? null]);
  } catch (stringifyErr) {
    console.warn('[Signup] Unreadable unique-violation details:', stringifyErr instanceof Error ? stringifyErr.message : stringifyErr);
    return '';
  }
}

const USER_RESULT_SELECT = {
  id: true,
  username: true,
  displayName: true,
  email: true,
  avatarUrl: true,
  bio: true,
  status: true,
  role: true,
  totpEnabled: true,
  emailVerified: true,
  isSupporter: true,
  supporterTier: true,
  tokenVersion: true,
  createdAt: true,
  ...CONSENT_SELECT,
} as const;

/**
 * Create the account from a pending registration and its code. Every refusal
 * of the code itself (unknown id, expired, wrong, used up) is one 400. A taken
 * username is a 409 that does NOT cost an attempt and accepts a new `username`
 * with the same code.
 */
export async function completeRegistration(
  pendingId: unknown,
  code: unknown,
  usernameOverride: unknown,
  rawIp: string | undefined,
) {
  if (typeof pendingId !== 'string' || pendingId.length === 0 || pendingId.length > 64
    || typeof code !== 'string' || !new RegExp(`^\\d{${SIGNUP.CODE_LENGTH}}$`).test(code)) {
    throw new BadRequestError(SIGNUP_CODE_INVALID_MESSAGE);
  }
  if (usernameOverride !== undefined && typeof usernameOverride !== 'string') {
    throw new BadRequestError('Username must be a string');
  }

  // Count the guess atomically (never read-then-write), and only while the
  // row is alive and under its cap.
  const rows = await prisma.$queryRaw<Array<{
    id: string; username: string; email: string; email_canonical: string; display_name: string;
    password_hash: string; code_hash: string; terms_accepted_at: Date; privacy_accepted_at: Date; ip: string | null;
  }>>`
    UPDATE pending_registrations SET attempts = attempts + 1
    WHERE id = ${pendingId}
      AND attempts < ${SIGNUP.MAX_CODE_ATTEMPTS}
      AND expires_at > (now() AT TIME ZONE 'UTC')
      AND code_expires_at > (now() AT TIME ZONE 'UTC')
    RETURNING id, username, email, email_canonical, display_name, password_hash, code_hash,
              terms_accepted_at, privacy_accepted_at, ip`;
  const row = rows[0];
  if (!row || !sameHash(signupCodeHash(row.id, code), row.code_hash)) {
    throw new BadRequestError(SIGNUP_CODE_INVALID_MESSAGE);
  }

  // The code is right: from here no failure counts as a guess.
  const refundAttempt = () => prisma.pendingRegistration
    .update({ where: { id: row.id }, data: { attempts: { decrement: 1 } } })
    .catch((err) => console.warn('[Signup] Attempt refund failed:', err instanceof Error ? err.message : err));

  const username = (usernameOverride as string | undefined) ?? row.username;
  if (usernameOverride !== undefined) {
    const usernameErr = validateUsername(username);
    if (usernameErr) { await refundAttempt(); throw new BadRequestError(usernameErr); }
  }
  const nameTaken = await prisma.user.findFirst({
    where: { username: { equals: username, mode: 'insensitive' } },
    select: { id: true },
  });
  if (nameTaken) { await refundAttempt(); throw new ConflictError(USERNAME_TAKEN_MESSAGE); }

  const holders = await prisma.user.findMany({
    where: { OR: [{ email: row.email }, { emailCanonical: row.email_canonical }] },
    select: { id: true, emailVerified: true, role: true, ownedServers: { select: { id: true }, take: 1 } },
  });
  if (holders.some((h) => h.emailVerified)) {
    // Someone completed or verified this address meanwhile. The caller proved
    // they read the mailbox, so telling them is no disclosure.
    await prisma.pendingRegistration.delete({ where: { id: row.id } }).catch((err) => {
      console.warn('[Signup] Pending registration cleanup failed:', err instanceof Error ? err.message : err);
    });
    throw new ConflictError(SIGNUP_EMAIL_REGISTERED_MESSAGE);
  }
  // An unverified legacy account on this mailbox (an abandoned sign-up, or a
  // row someone else created with the address): the code proves the mailbox,
  // that row never did. It goes the way every account goes, under the guards
  // the hygiene sweep applies (role 'user', no owned server). One that fails
  // them is never deleted from here: the address stays taken (409, and the
  // guess is given back, the code was right).
  if (holders.some((h) => h.role !== 'user' || h.ownedServers.length > 0)) {
    await refundAttempt();
    throw new ConflictError(SIGNUP_EMAIL_REGISTERED_MESSAGE);
  }
  for (const legacy of holders) {
    try {
      await deleteUserAccount(legacy.id, { reason: 'superseded by a verified sign-up', logPrefix: '[Signup]' });
    } catch (err) {
      // A parallel completion with the same code deleted it first: already gone.
      if ((err as { code?: string })?.code !== 'P2025') throw err;
      console.warn('[Signup] Legacy account already deleted by a parallel completion');
    }
  }

  let user;
  try {
    user = await prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          username,
          email: row.email,
          emailCanonical: row.email_canonical,
          displayName: row.display_name,
          password: row.password_hash,
          emailVerified: true,
          emailVerifiedAt: new Date(),
          termsAcceptedAt: row.terms_accepted_at,
          privacyAcceptedAt: row.privacy_accepted_at,
        },
        select: USER_RESULT_SELECT,
      });
      await tx.pendingRegistration.delete({ where: { id: row.id } });
      return created;
    });
  } catch (err) {
    // The unique indexes are the real enforcement (two completions racing).
    if ((err as { code?: string })?.code === 'P2002') {
      await refundAttempt();
      if (/email/i.test(uniqueViolationTarget(err))) throw new ConflictError(SIGNUP_EMAIL_REGISTERED_MESSAGE);
      throw new ConflictError(USERNAME_TAKEN_MESSAGE);
    }
    throw err;
  }

  const domain = emailDomain(row.email);
  if (!isCommonEmailProvider(domain)) await countDomainRegistration(domain);

  // The registration address is the one the start came from (the request
  // that solved the proof-of-work); the completing one only when the start's
  // is unknown. The stored value is already normalized.
  const ip = row.ip ?? (rawIp ? normalizeIp(rawIp) : undefined);
  if (ip) {
    const geo = geoip.lookup(ip);
    const countryNames = new Intl.DisplayNames(['en'], { type: 'region' });
    const geoFields = geo ? {
      countryCode: geo.country || null,
      country: (geo.country && countryNames.of(geo.country)) || geo.country || null,
    } : {};
    await prisma.ipRecord.create({
      data: { userId: user.id, ip, kind: 'register', ...geoFields },
    }).catch((err) => console.warn('[Signup] Registration IP record failed:', err instanceof Error ? err.message : err));
  }

  const tokens = generateTokens({ userId: user.id, username: user.username, role: user.role as UserRole, tokenVersion: user.tokenVersion });
  const { tokenVersion: _, ...safeUser } = user;
  return { user: withConsentFlag(safeUser), ...tokens };
}

/**
 * Housekeeping, run with the nightly registration hygiene: expired pending
 * registrations and ledger rows past their window. Both are inert once
 * expired (every check reads the timestamps); this only keeps the tables small.
 */
export async function purgeExpiredSignupState(): Promise<{ pending: number; ledger: number }> {
  const pending = await prisma.pendingRegistration.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  const ledger = await prisma.signupMailLedger.deleteMany({
    where: { windowStartAt: { lt: new Date(Date.now() - SIGNUP.LEDGER_WINDOW_DAYS * 24 * 60 * MINUTE) } },
  });
  return { pending: pending.count, ledger: ledger.count };
}
