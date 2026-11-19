// Test setup — load env vars BEFORE any test modules import server code.
// This mirrors what dotenv.config() does in index.ts, but for the test environment.
import dotenv from 'dotenv';
import path from 'path';
import { TEST_JWT_SECRET, TEST_JWT_REFRESH_SECRET } from './helpers/testSecrets';

// Load .env.test if it exists, otherwise fall back to .env
dotenv.config({ path: path.resolve(__dirname, '../../.env.test'), quiet: true });
dotenv.config({ path: path.resolve(__dirname, '../../.env'), quiet: true });

// The token secrets are the suite's own, assigned after the files above and
// over the shell's: a fresh clone has no .env and CI's unit-test step sets no
// JWT variable, and both must run the suite exactly as a developer's machine
// does. Winning over a local .env also keeps a developer's real secret (and
// the keys derived from it: the proof-of-work HMAC, the cursor signatures,
// the login-account digest) out of every test run. A test that needs another
// value sets it itself and puts this one back.
process.env.JWT_SECRET = TEST_JWT_SECRET;
process.env.JWT_REFRESH_SECRET = TEST_JWT_REFRESH_SECRET;
