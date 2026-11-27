import i18n from 'i18next';
import type { TFunction } from 'i18next';
import { isToday, isYesterday } from 'date-fns';

/**
 * Every date and time a person reads goes through here: `Intl.DateTimeFormat`
 * in the language chosen in the app (not the operating system's, not English),
 * one cached formatter per language, form and time zone.
 *
 * Nothing is memoised across a language change: a component calls this while it
 * renders (it already re-renders on a language change through `useTranslation`)
 * and passes nothing, or passes the language it was given.
 *
 * The legal documents are the one exception on purpose: they print their dates
 * through `components/legal/legalDates.ts` (fixed month names, no `Intl`).
 */

export type DateForm =
  /** "Nov 23, 2026": a calendar date */
  | 'date'
  /** "November 23, 2026": the day separator of the message lists */
  | 'longDate'
  /** "3:45 PM" */
  | 'time'
  /** "3:45": the hover time of a grouped message (no AM/PM, as before) */
  | 'clock'
  /** "Nov 23, 2026, 3:45 PM": a date (short month name, so no reader mistakes day and month) and a time */
  | 'dateTime';

export interface FormatDateOptions {
  /** A language tag; the app's current language when absent */
  language?: string;
  /** An IANA zone; the device's own when absent */
  timeZone?: string;
}

const FORM_OPTIONS: Record<DateForm, Intl.DateTimeFormatOptions> = {
  date: { dateStyle: 'medium' },
  longDate: { year: 'numeric', month: 'long', day: 'numeric' },
  time: { hour: 'numeric', minute: '2-digit' },
  clock: { hour: 'numeric', minute: '2-digit' },
  dateTime: { dateStyle: 'medium', timeStyle: 'short' },
};

/** The options a form uses, for tests that compare with `Intl.DateTimeFormat` */
export function dateFormOptions(form: DateForm, timeZone?: string): Intl.DateTimeFormatOptions {
  return { ...FORM_OPTIONS[form], ...(timeZone ? { timeZone } : {}) };
}

const cache = new Map<string, Intl.DateTimeFormat>();
const warned = new Set<string>();

/** The language of the app now, or undefined before i18n is initialised */
export function currentLanguage(): string | undefined {
  return i18n.language || undefined;
}

function formatterFor(form: DateForm, language: string | undefined, timeZone: string | undefined): Intl.DateTimeFormat {
  const key = `${language ?? ''}|${form}|${timeZone ?? ''}`;
  const held = cache.get(key);
  if (held) return held;
  const options = dateFormOptions(form, timeZone);
  let made: Intl.DateTimeFormat;
  try {
    made = new Intl.DateTimeFormat(language, options);
  } catch (err) {
    // An unusable language tag (or zone): the runtime's own default, once reported
    if (!warned.has(key)) {
      warned.add(key);
      console.warn('[Dates] Unusable language or time zone, using the default:', err instanceof Error ? err.message : String(err));
    }
    made = new Intl.DateTimeFormat(undefined, { ...options, timeZone: undefined });
  }
  cache.set(key, made);
  return made;
}

/**
 * `value` printed in `form`; an empty string for a date that does not parse
 * (the callers show nothing rather than "Invalid Date").
 */
export function formatDate(form: DateForm, value: Date | string | number, options: FormatDateOptions = {}): string {
  const date = value instanceof Date ? value : new Date(value);
  const time = date.getTime();
  if (!Number.isFinite(time)) return '';
  const formatter = formatterFor(form, options.language ?? currentLanguage(), options.timeZone);
  if (form !== 'clock') return formatter.format(date);
  // The hover time shows the hour and minute only: the day period (AM/PM) is
  // dropped, with the space that set it apart.
  const parts = formatter.formatToParts(date);
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.type === 'dayPeriod') {
      if (out.length > 0 && /^\s+$/.test(parts[i - 1]?.value ?? '') && parts[i - 1]?.type === 'literal') out.pop();
      continue;
    }
    if (part.type === 'literal' && out.length === 0) continue;
    out.push(part.value);
  }
  return out.join('').trim();
}

/**
 * The timestamp of a chat row: "Today at 3:45 PM", "Yesterday at 3:45 PM"
 * (the wording is `messageItem.todayAt` / `yesterdayAt`), else the date with a
 * month name and the time. An empty string for a date that does not parse.
 */
export function formatMessageStamp(value: Date | string | number, t: TFunction, options: FormatDateOptions = {}): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  if (isToday(date)) return t('messageItem.todayAt', { time: formatDate('time', date, options) });
  if (isYesterday(date)) return t('messageItem.yesterdayAt', { time: formatDate('time', date, options) });
  return formatDate('dateTime', date, options);
}

/** Forget every formatter (tests) */
export function resetDateFormatters(): void {
  cache.clear();
  warned.clear();
}

/** How many formatters are held (tests) */
export function dateFormatterCount(): number {
  return cache.size;
}
