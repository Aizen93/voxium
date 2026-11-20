export type LicenseVerdict =
  | { ok: true }
  | { ok: false; kind: 'copyleft' | 'unknown' | 'not-allowed'; terms: string[] };

export interface LicenseException { package: string; license: string; reason: string; onlyRequiredBy?: string[] }
export interface LicensePolicy { allowed: string[]; allowedDevelopmentOnly?: string[]; exceptions: LicenseException[] }
export interface LicenseFinding {
  name: string;
  versions: string[];
  license: string;
  kind: 'copyleft' | 'unknown' | 'not-allowed' | 'development-only';
  production: boolean | undefined;
  strayDependents?: string[];
}

export function isPackageName(name: unknown): name is string;
export function judgeLicense(license: string | null | undefined, allowed: Iterable<string>): LicenseVerdict;
export function validatePolicy(policy: unknown): Required<LicensePolicy>;
export function checkLicenses(
  byLicense: Record<string, { name: string; versions?: string[] }[]>,
  policy: LicensePolicy,
  productionNames?: Set<string>,
  directDependents?: (name: string) => string[] | null,
): {
  refused: LicenseFinding[];
  excepted: (LicenseFinding & { reason: string })[];
  developmentOnly: LicenseFinding[];
  unusedExceptions: LicenseException[];
};
export function describeFinding(finding: LicenseFinding): string;
