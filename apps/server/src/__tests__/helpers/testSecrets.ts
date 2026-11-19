/**
 * The token secrets every server unit test runs with. setup.ts assigns them
 * before any test file is imported, over whatever the shell or a local
 * apps/server/.env holds: a fresh clone (no .env) and CI (no JWT variable in
 * the unit-test step) run the suite exactly as a developer's machine does,
 * and a unit test never signs with a developer's real secret.
 *
 * Test-only values. Nothing outside src/__tests__ may import this file.
 */
export const TEST_JWT_SECRET = 'voxium-unit-tests-jwt-secret-not-a-real-key';
export const TEST_JWT_REFRESH_SECRET = 'voxium-unit-tests-jwt-refresh-secret-not-a-real-key';
