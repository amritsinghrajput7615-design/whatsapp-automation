/**
 * StatusBadge — colour-coded pill for message / reminder statuses.
 *
 * Supported statuses: sent, failed, pending, no_phone,
 *                     completed, too_soon, manual
 */

const CONFIG = {
  sent:      { label: 'Sent',       cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  failed:    { label: 'Failed',     cls: 'bg-red-50 text-red-700 border-red-200' },
  pending:   { label: 'Pending',    cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  no_phone:  { label: 'No Phone',   cls: 'bg-gray-100 text-gray-600 border-gray-200' },
  completed: { label: 'Completed',  cls: 'bg-blue-50 text-blue-700 border-blue-200' },
  too_soon:  { label: 'Too Soon',   cls: 'bg-slate-100 text-slate-600 border-slate-200' },
  manual:    { label: 'Manual',     cls: 'bg-purple-50 text-purple-700 border-purple-200' },
  order_confirmation: { label: 'Order',    cls: 'bg-blue-50 text-blue-700 border-blue-200' },
  abandoned_cart:     { label: 'Cart',     cls: 'bg-orange-50 text-orange-700 border-orange-200' },
};

export function StatusBadge({ status }) {
  const cfg = CONFIG[status] || {
    label: status ?? '—',
    cls: 'bg-gray-100 text-gray-600 border-gray-200',
  };

  return (
    <span
      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-semibold border ${cfg.cls}`}
    >
      {cfg.label}
    </span>
  );
}
