/**
 * DataTable — a generic, reusable table component.
 *
 * Props:
 *   columns      – array of { key, label, render?, className? }
 *   data         – array of row objects
 *   loading      – show skeleton rows
 *   emptyMessage – shown when data is empty
 *   keyField     – field name to use as React key (default: 'id')
 */
export function DataTable({
  columns,
  data,
  loading = false,
  emptyMessage = 'No data found.',
  keyField = 'id',
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-gray-100">
      <table className="min-w-full divide-y divide-gray-100">
        <thead>
          <tr className="bg-gray-50">
            {columns.map((col) => (
              <th
                key={col.key}
                className={`px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-gray-500 ${col.className || ''}`}
              >
                {col.label}
              </th>
            ))}
          </tr>
        </thead>

        <tbody className="bg-white divide-y divide-gray-50">
          {loading ? (
            // Skeleton rows
            Array.from({ length: 6 }).map((_, i) => (
              <tr key={i} className="animate-pulse">
                {columns.map((col) => (
                  <td key={col.key} className="px-5 py-3.5">
                    <div className="skeleton h-3.5 w-full max-w-[120px]" />
                  </td>
                ))}
              </tr>
            ))
          ) : data.length === 0 ? (
            <tr>
              <td
                colSpan={columns.length}
                className="px-5 py-16 text-center text-sm text-gray-400"
              >
                {emptyMessage}
              </td>
            </tr>
          ) : (
            data.map((row, rowIdx) => (
              <tr
                key={row[keyField] ?? rowIdx}
                className="hover:bg-gray-50 transition-colors duration-100"
              >
                {columns.map((col) => (
                  <td
                    key={col.key}
                    className={`px-5 py-3.5 text-sm text-gray-700 ${col.className || ''}`}
                  >
                    {col.render
                      ? col.render(row[col.key], row)
                      : (row[col.key] ?? '—')}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
