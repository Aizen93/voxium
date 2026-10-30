/**
 * Register a test account through the API, verify-first: start the
 * registration (proof-of-work + consent, the same path a browser takes),
 * replace the mailed code's stored hash with the hash of a known code in the
 * database (the sanctioned test path; there is no server bypass), then
 * complete it. The account is created verified and signed in.
 *
 * Shared by the load and integration scripts. DATABASE_URL comes from the
 * environment or apps/server/.env.
 */
import axios from 'axios';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../apps/server/src/generated/prisma/client';
import { solveRegistrationPow } from '../../packages/shared/src/pow';

/** The code every scripted registration completes with. */
export const TEST_SIGNUP_CODE = '123456';

export interface RegisteredTestUser {
  accessToken: string;
  refreshToken: string;
  user: { id: string; username: string; email: string; [key: string]: unknown };
}

let prisma: PrismaClient | null = null;

function getPrisma(): PrismaClient {
  if (!prisma) {
    // dotenv never overrides a variable already set
    dotenv.config({ path: resolve(__dirname, '../../apps/server/.env'), quiet: true });
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL is not set and apps/server/.env does not define it');
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  }
  return prisma;
}

/** The stored form of a sign-up code — `signupCodeHash` in apps/server/src/services/signupService.ts. */
function signupCodeHash(pendingId: string, code: string): string {
  return createHash('sha256').update(`${pendingId}:${code}`).digest('hex');
}

/**
 * Register `user` against the API at `api` (e.g. http://localhost:3001/api/v1).
 * Errors are the axios errors of the failing call, so a caller can still read
 * `err.response.status` (409 on the start = the username is taken).
 */
export async function registerTestUser(
  api: string,
  user: { username: string; email: string; password: string; displayName?: string },
): Promise<RegisteredTestUser> {
  const { data: chal } = await axios.get(`${api}/auth/register-challenge`);
  const pow = await solveRegistrationPow(chal.data);
  const { data: started } = await axios.post(`${api}/auth/register`, {
    ...user, pow, acceptTerms: true, acceptPrivacy: true,
  });
  const pendingId: string = started.data.pendingId;

  const { count } = await getPrisma().pendingRegistration.updateMany({
    where: { id: pendingId },
    data: { codeHash: signupCodeHash(pendingId, TEST_SIGNUP_CODE) },
  });
  if (count !== 1) throw new Error(`Pending registration ${pendingId} not found in the database`);

  const { data: completed } = await axios.post(`${api}/auth/register/complete`, { pendingId, code: TEST_SIGNUP_CODE });
  return completed.data as RegisteredTestUser;
}

/** Close the database connection (call once before the script exits). */
export async function closeRegisterTestUserDb(): Promise<void> {
  if (prisma) {
    const db = prisma;
    prisma = null;
    await db.$disconnect();
  }
}
