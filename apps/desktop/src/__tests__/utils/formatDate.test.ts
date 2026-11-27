import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import i18n from 'i18next';
import { formatDate, formatMessageStamp, resetDateFormatters, dateFormatterCount, currentLanguage } from '../../utils/formatDate';

// Every form, in several languages, against Intl.DateTimeFormat given the same
// options here (never a literal that depends on the ICU data of the machine).
// A fixed instant and zone keep the day and hour the same everywhere.

const AT = new Date('2026-11-23T15:45:30.000Z');
const TZ = 'UTC';
const LANGS = ['en', 'fr', 'ja', 'ar'] as const;

const EXPECTED: Record<string, Intl.DateTimeFormatOptions> = {
  date: { dateStyle: 'medium' },
  longDate: { year: 'numeric', month: 'long', day: 'numeric' },
  time: { hour: 'numeric', minute: '2-digit' },
  dateTime: { dateStyle: 'medium', timeStyle: 'short' },
};

beforeEach(() => resetDateFormatters());
afterEach(() => vi.restoreAllMocks());

describe('formatDate forms follow the language given', () => {
  for (const language of LANGS) {
    for (const [form, options] of Object.entries(EXPECTED)) {
      it(`${form} in ${language}`, () => {
        const want = new Intl.DateTimeFormat(language, { ...options, timeZone: TZ }).format(AT);
        expect(formatDate(form as 'date', AT, { language, timeZone: TZ })).toBe(want);
      });
    }

    it(`clock in ${language} is the time without its day period`, () => {
      const parts = new Intl.DateTimeFormat(language, { hour: 'numeric', minute: '2-digit', timeZone: TZ }).formatToParts(AT);
      const want = parts.filter((p) => p.type !== 'dayPeriod').map((p) => p.value).join('').trim();
      const got = formatDate('clock', AT, { language, timeZone: TZ });
      expect(got).toBe(want);
      expect(parts.some((p) => p.type === 'dayPeriod') ? got : '').not.toMatch(/PM|AM/);
    });
  }

  it('says the same thing in English as the old hand-built forms did', () => {
    expect(formatDate('longDate', AT, { language: 'en', timeZone: TZ })).toBe('November 23, 2026');
    expect(formatDate('date', AT, { language: 'en', timeZone: TZ })).toBe('Nov 23, 2026');
    expect(formatDate('clock', AT, { language: 'en', timeZone: TZ })).toBe('3:45');
    expect(formatDate('dateTime', AT, { language: 'en', timeZone: TZ })).toMatch(/^Nov 23, 2026, 3:45\sPM$/);
  });

  it('different languages print differently (French and Japanese are not the English text)', () => {
    const en = formatDate('longDate', AT, { language: 'en', timeZone: TZ });
    expect(formatDate('longDate', AT, { language: 'fr', timeZone: TZ })).not.toBe(en);
    expect(formatDate('longDate', AT, { language: 'ja', timeZone: TZ })).not.toBe(en);
  });
});

describe('formatDate inputs', () => {
  it('takes a Date, an ISO string and a number alike', () => {
    const want = formatDate('date', AT, { language: 'en', timeZone: TZ });
    expect(formatDate('date', AT.toISOString(), { language: 'en', timeZone: TZ })).toBe(want);
    expect(formatDate('date', AT.getTime(), { language: 'en', timeZone: TZ })).toBe(want);
  });

  it('answers an empty string for a date that does not parse', () => {
    expect(formatDate('dateTime', 'not a date', { language: 'en' })).toBe('');
    expect(formatDate('clock', new Date(NaN), { language: 'en' })).toBe('');
  });

  it('falls back to the default language, once reported, for an unusable tag', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(formatDate('date', AT, { language: 'xx-@@', timeZone: TZ })).toBe(new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: TZ }).format(AT));
    formatDate('date', AT, { language: 'xx-@@', timeZone: TZ });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('[Dates]');
  });
});

describe('the formatter cache', () => {
  it('holds one formatter per language, form and zone', () => {
    formatDate('date', AT, { language: 'en', timeZone: TZ });
    formatDate('date', AT, { language: 'en', timeZone: TZ });
    expect(dateFormatterCount()).toBe(1);
    formatDate('date', AT, { language: 'fr', timeZone: TZ });
    formatDate('time', AT, { language: 'fr', timeZone: TZ });
    formatDate('time', AT, { language: 'fr' });
    expect(dateFormatterCount()).toBe(4);
  });
});

describe('the language of the app', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('is read when nothing is given, so a change of language shows at the next render', async () => {
    await i18n.init({ lng: 'en', resources: { en: { translation: {} }, fr: { translation: {} } } }).catch(() => undefined);
    await i18n.changeLanguage('en');
    expect(currentLanguage()).toBe('en');
    const en = formatDate('longDate', AT, { timeZone: TZ });
    expect(en).toBe(new Intl.DateTimeFormat('en', { ...EXPECTED.longDate, timeZone: TZ }).format(AT));
    await i18n.changeLanguage('fr');
    const fr = formatDate('longDate', AT, { timeZone: TZ });
    expect(fr).toBe(new Intl.DateTimeFormat('fr', { ...EXPECTED.longDate, timeZone: TZ }).format(AT));
    expect(fr).not.toBe(en);
  });
});

describe('formatMessageStamp', () => {
  const t = ((key: string, opts?: { time?: string }) => `${key}|${opts?.time ?? ''}`) as unknown as Parameters<typeof formatMessageStamp>[1];

  afterEach(() => vi.useRealTimers());

  it('says today and yesterday through the keys, with the time in the language', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-23T20:00:00'));
    const time = new Intl.DateTimeFormat('fr', { hour: 'numeric', minute: '2-digit' }).format(new Date('2026-11-23T09:05:00'));
    expect(formatMessageStamp('2026-11-23T09:05:00', t, { language: 'fr' })).toBe(`messageItem.todayAt|${time}`);
    expect(formatMessageStamp('2026-11-22T09:05:00', t, { language: 'fr' })).toMatch(/^messageItem\.yesterdayAt\|/);
  });

  it('prints an older day as the date and time of the language', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-23T20:00:00'));
    for (const language of LANGS) {
      const want = new Intl.DateTimeFormat(language, EXPECTED.dateTime).format(new Date('2026-10-01T09:05:00'));
      expect(formatMessageStamp('2026-10-01T09:05:00', t, { language })).toBe(want);
    }
  });

  it('is empty for a date that does not parse', () => {
    expect(formatMessageStamp('garbage', t)).toBe('');
  });
});
