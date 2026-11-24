export const APOSTROPHE: '\u2019';
export const NBSP: '\u00a0';
export const KEPT_AS_WRITTEN: ReadonlyMap<string, string>;
export function setFrenchTypography(value: string, options?: { jsonEscapes?: boolean }): string;
export function setFrenchTypographyInJson(text: string): string;
export function stringValues(bundle: unknown, prefix?: string): Array<[string, string]>;
export function setFrenchApostrophes(value: string): string;
