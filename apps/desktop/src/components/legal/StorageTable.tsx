/** One item the app keeps on the user's device, as a row of the Cookie Policy. */
export interface StorageRow {
  item: string;
  purpose: string;
  where: string;
  duration: string;
}

/** The column headings of a storage table, in the language of the document. */
export type StorageTableHeaders = Record<keyof StorageRow, string>;

/** A Cookie Policy table: the same layout in every language (CookiePolicyContent.en.tsx / .fr.tsx). */
export function StorageTable({ caption, headers, rows }: { caption: string; headers: StorageTableHeaders; rows: StorageRow[] }) {
  return (
    <div className="rounded-lg border border-vox-border overflow-x-auto mb-4">
      <table className="w-full text-sm">
        <caption className="text-left px-4 py-2.5 text-vox-text-primary font-semibold bg-vox-bg-secondary">
          {caption}
        </caption>
        <thead>
          <tr className="bg-vox-bg-secondary">
            <th className="text-left px-4 py-2.5 text-vox-text-primary font-semibold">{headers.item}</th>
            <th className="text-left px-4 py-2.5 text-vox-text-primary font-semibold">{headers.purpose}</th>
            <th className="text-left px-4 py-2.5 text-vox-text-primary font-semibold">{headers.where}</th>
            <th className="text-left px-4 py-2.5 text-vox-text-primary font-semibold">{headers.duration}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-vox-border">
          {rows.map((row) => (
            <tr key={row.item}>
              <td className="px-4 py-2.5 align-top break-words">{row.item}</td>
              <td className="px-4 py-2.5 align-top">{row.purpose}</td>
              <td className="px-4 py-2.5 align-top">{row.where}</td>
              <td className="px-4 py-2.5 align-top">{row.duration}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
