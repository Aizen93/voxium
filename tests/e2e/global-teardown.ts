import { disconnectDb } from './helpers/db';

/**
 * Global teardown: disconnect the shared PrismaClient so the Playwright
 * worker process doesn't hang on open DB handles.
 */
async function globalTeardown() {
  await disconnectDb();
}

export default globalTeardown;
