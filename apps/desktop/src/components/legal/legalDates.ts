const MONTHS: Record<'en' | 'fr', readonly string[]> = {
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  fr: ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'],
};

/** A `YYYY-MM-DD` string as its parts; throws on anything that is not a real calendar date. */
function parseIsoDate(iso: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) throw new Error(`Not a YYYY-MM-DD date: "${iso}"`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > lengths[month - 1]) {
    throw new Error(`Not a real calendar date: "${iso}"`);
  }
  return { year, month, day };
}

/**
 * A `YYYY-MM-DD` date as the legal documents write it: "December 4, 2026" /
 * "4 décembre 2026" ("1er décembre 2026" for the first of a month, in French).
 * Parsed by its parts, with fixed month names: no time zone, no Intl.
 */
export function formatLegalDate(iso: string, language: 'en' | 'fr'): string {
  const { year, month, day } = parseIsoDate(iso);
  const name = MONTHS[language][month - 1];
  if (language === 'en') return `${name} ${day}, ${year}`;
  return `${day === 1 ? '1er' : String(day)} ${name} ${year}`;
}

/** Whole days from `isoA` to `isoB` (negative when `isoB` is earlier); both must be real `YYYY-MM-DD` dates. */
export function daysBetween(isoA: string, isoB: string): number {
  const a = parseIsoDate(isoA);
  const b = parseIsoDate(isoB);
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000);
}
