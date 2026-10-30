// ─── CSV export ─────────────────────────────────────────────────────────────
// RFC 4180 quoting plus spreadsheet-formula neutralisation (OWASP "CSV
// injection"). Exported cells hold values chosen by any user (display names,
// space names, e-mail addresses), and a spreadsheet application evaluates a cell
// that starts with = + - @ (or a tab / carriage return before one of them) as a
// formula, even inside quotes. A leading apostrophe makes it plain text.

export interface CsvColumn {
  key: string;
  label: string;
}

const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

/** One cell: neutralised first, then quoted when it holds , " CR or LF. */
export function escapeCsvCell(val: unknown): string {
  let str = val == null ? '' : String(val);
  if (FORMULA_TRIGGER.test(str)) str = `'${str}`;
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/** Header row plus one row per record, CRLF line ends. */
export function generateCSV(rows: ReadonlyArray<Record<string, unknown>>, columns: readonly CsvColumn[]): string {
  const header = columns.map((c) => escapeCsvCell(c.label)).join(',');
  const body = rows.map((row) => columns.map((c) => escapeCsvCell(row[c.key])).join(',')).join('\r\n');
  return `${header}\r\n${body}`;
}
