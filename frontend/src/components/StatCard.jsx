/**
 * StatCard — summary metric card displayed on the Dashboard.
 *
 * Props:
 *   title      – label above the value
 *   value      – primary large number / text
 *   icon       – lucide-react icon component
 *   iconBg     – Tailwind background class for icon container  (e.g. 'bg-emerald-50')
 *   iconColor  – Tailwind text class for icon                  (e.g. 'text-emerald-600')
 *   subtitle   – optional small line below value
 *   loading    – show skeleton
 */
export function StatCard({ title, value, icon: Icon, iconBg, iconColor, subtitle, loading }) {
  if (loading) {
    return (
      <div className="card p-6 animate-pulse">
        <div className="flex items-start justify-between">
          <div className="space-y-2 flex-1">
            <div className="skeleton h-3 w-24" />
            <div className="skeleton h-8 w-16 mt-1" />
            <div className="skeleton h-2.5 w-20" />
          </div>
          <div className="skeleton h-12 w-12 rounded-xl" />
        </div>
      </div>
    );
  }

  return (
    <div className="card p-6 hover:shadow-md transition-shadow duration-200 animate-fade-in">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm font-medium text-gray-500">{title}</p>
          <p className="mt-1 text-3xl font-bold text-gray-900 tabular-nums">
            {value ?? '—'}
          </p>
          {subtitle && (
            <p className="mt-1 text-xs text-gray-400">{subtitle}</p>
          )}
        </div>
        <div
          className={`w-12 h-12 rounded-xl flex items-center justify-center shrink-0 ${iconBg}`}
        >
          <Icon size={22} className={iconColor} />
        </div>
      </div>
    </div>
  );
}
