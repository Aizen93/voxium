/**
 * The demo seed (prisma/seed.ts) creates three accounts, alice, bob and
 * charlie, e-mail-verified and consented, with the password the README
 * prints. That is what a development database wants and what no public
 * instance may hold: anyone could sign in to them.
 *
 * So the seed refuses to run under a production configuration
 * (`NODE_ENV=production`, what the server image and
 * docker-compose.production.yml set) unless the operator says so for that
 * one run, with `VOXIUM_ALLOW_DEMO_SEED=1` in the command's environment.
 * Like `VOXIUM_ALLOW_CUTOVER`, only the exact value `1` counts, and it
 * belongs on the command line, never in an env file that every later run
 * would read too.
 *
 * Development, test and CI databases need no flag: none of them runs with
 * NODE_ENV=production.
 */

export const DEMO_SEED_OVERRIDE = 'VOXIUM_ALLOW_DEMO_SEED';

export interface DemoSeedSettings {
  /** NODE_ENV as the seed sees it (after its .env is loaded). */
  nodeEnv: string | undefined;
  /** VOXIUM_ALLOW_DEMO_SEED from the command's environment. */
  allowDemoSeed: string | undefined;
}

/** Why the seed must not run, or null when it may. */
export function demoSeedRefusal({ nodeEnv, allowDemoSeed }: DemoSeedSettings): string | null {
  if (nodeEnv !== 'production') return null;
  if (allowDemoSeed === '1') return null;
  return [
    'Refusing to seed demo data: NODE_ENV=production.',
    'The demo seed creates the accounts alice, bob and charlie, verified, with the password printed in the README:',
    'on a public instance anyone could sign in to them. It is meant for development databases.',
    `To seed a production-configured database anyway, run it once with ${DEMO_SEED_OVERRIDE}=1 in the command's environment.`,
  ].join('\n');
}

/** The warning printed when the override let the seed run in production. */
export function demoSeedOverrideWarning(): string {
  return `WARNING: ${DEMO_SEED_OVERRIDE}=1 under NODE_ENV=production: seeding the demo accounts (alice, bob, charlie) with the published password. Delete them or change their passwords before anyone else can reach this instance.`;
}
