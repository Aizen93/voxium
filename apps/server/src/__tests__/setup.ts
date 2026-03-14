// Test setup — load env vars BEFORE any test modules import server code.
// This mirrors what dotenv.config() does in index.ts, but for the test environment.
import dotenv from 'dotenv';
import path from 'path';

// Load .env.test if it exists, otherwise fall back to .env
dotenv.config({ path: path.resolve(__dirname, '../../.env.test') });
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
