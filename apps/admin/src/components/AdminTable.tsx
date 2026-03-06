import { ChevronLeft, ChevronRight } from 'lucide-react';

interface AdminTableProps {
  columns: Array<{ key: string; label: string; width?: string }>;
  rows: Array<Record<string, React.ReactNode>>;
  page: number;
  total: number;
  limit?: number;
  onPageChange: (page: number) => void;
  onRowClick?: (index: number) => void;
}

export function AdminTable({ columns, rows, page, total, limit = 12, onPageChange, onRowClick }: AdminTableProps) {
  const totalPages = Math.ceil(total / limit);

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-vox-border">
              {columns.map((col) => (
                <th key={col.key} className="px-4 py-3 text-left text-xs font-medium text-vox-text-muted uppercase" style={{ width: col.width }}>
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-4 py-8 text-center text-vox-text-muted">
                  No results found
                </td>
              </tr>
            ) : (
              rows.map((row, i) => (
                <tr
                  key={i}
                  className={`border-b border-vox-border/50 hover:bg-vox-bg-hover transition-colors ${onRowClick ? 'cursor-pointer' : ''}`}
                  onClick={() => onRowClick?.(i)}
                >
                  {columns.map((col) => (
                    <td key={col.key} className="px-4 py-3 text-vox-text-secondary">
                      {row[col.key]}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {rows.length > 0 && (
        <div className="flex items-center justify-between px-4 py-3 border-t border-vox-border">
          <span className="text-xs text-vox-text-muted">
            Showing {(page - 1) * limit + 1}-{Math.min(page * limit, total)} of {total}
          </span>
          {totalPages > 1 && (
            <div className="flex items-center gap-2">
              <button
                onClick={() => onPageChange(page - 1)}
                disabled={page <= 1}
                className="p-1 rounded text-vox-text-muted hover:text-vox-text-primary disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <ChevronLeft size={16} />
              </button>
              <span className="text-xs text-vox-text-secondary">
                {page} / {totalPages}
              </span>
              <button
                onClick={() => onPageChange(page + 1)}
                disabled={page >= totalPages}
                className="p-1 rounded text-vox-text-muted hover:text-vox-text-primary disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <ChevronRight size={16} />
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
