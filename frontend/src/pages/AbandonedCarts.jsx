import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, Send } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../api/endpoints';
import { DataTable } from '../components/DataTable';
import { StatusBadge } from '../components/StatusBadge';

function formatDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

export default function AbandonedCarts() {
  const [carts, setCarts]       = useState([]);
  const [total, setTotal]       = useState(0);
  const [loading, setLoading]   = useState(true);
  const [reminding, setReminding] = useState(null); // checkout id

  const fetchCarts = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getAbandonedCarts();
      setCarts(data.abandonedCarts);
      setTotal(data.total);
    } catch (err) {
      toast.error(`Failed to load carts: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchCarts(); }, [fetchCarts]);

  const handleRemind = async (checkoutId) => {
    setReminding(checkoutId);
    try {
      const result = await api.sendReminder(checkoutId);
      if (result.success) {
        toast.success('Abandoned cart reminder sent!');
        setCarts((prev) =>
          prev.map((c) =>
            c.checkoutId === checkoutId
              ? { ...c, reminded: true, reminderStatus: 'sent' }
              : c
          )
        );
      } else {
        toast.error(`Reminder failed: ${result.error}`);
      }
    } catch (err) {
      toast.error(err.message);
    } finally {
      setReminding(null);
    }
  };

  const columns = [
    {
      key: 'checkoutId',
      label: 'Checkout ID',
      render: (v) => (
        <span className="font-mono text-xs text-gray-500 truncate max-w-[120px] block">
          {v}
        </span>
      ),
    },
    { key: 'customerName', label: 'Customer' },
    {
      key: 'phone',
      label: 'Phone',
      render: (v) => (
        <span className="font-mono text-xs text-gray-500">{v || '—'}</span>
      ),
    },
    {
      key: 'totalPrice',
      label: 'Cart Value',
      render: (v, row) =>
        v ? (
          <span className="font-medium">
            {row.currency || 'USD'} {parseFloat(v).toFixed(2)}
          </span>
        ) : (
          '—'
        ),
    },
    {
      key: 'timeSince',
      label: 'Abandoned',
      render: (v) => <span className="text-xs text-gray-500">{v || '—'}</span>,
    },
    {
      key: 'lineItems',
      label: 'Items',
      render: (v) => (
        <span className="text-xs text-gray-500">
          {(v || []).length} item{(v || []).length !== 1 ? 's' : ''}
        </span>
      ),
    },
    {
      key: 'reminderStatus',
      label: 'Reminder',
      render: (v) => <StatusBadge status={v} />,
    },
    {
      key: 'checkoutId',
      label: 'Action',
      render: (id, row) => {
        const disabled =
          reminding === id ||
          row.reminded ||
          row.completedOrder ||
          !row.phone;

        const title = row.completedOrder
          ? 'Order completed — no reminder needed'
          : row.reminded
          ? 'Reminder already sent'
          : !row.phone
          ? 'No phone number'
          : 'Send WhatsApp reminder now';

        return (
          <button
            id={`remind-cart-${id}`}
            disabled={disabled}
            onClick={() => handleRemind(id)}
            className={disabled ? 'btn-secondary opacity-40 text-xs py-1.5 px-3' : 'btn-primary text-xs py-1.5 px-3'}
            title={title}
          >
            <Send size={12} className={reminding === id ? 'animate-spin' : ''} />
            {reminding === id ? 'Sending…' : 'Remind'}
          </button>
        );
      },
    },
  ];

  const pendingCount = carts.filter(
    (c) => !c.reminded && !c.completedOrder && c.isAbandoned
  ).length;

  return (
    <div className="p-8 animate-slide-up">
      {/* ── Header ── */}
      <div className="page-header flex items-start justify-between">
        <div>
          <h1 className="page-title">Abandoned Carts</h1>
          <p className="page-subtitle">
            {total} checkout{total !== 1 ? 's' : ''} tracked
            {pendingCount > 0 && (
              <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-orange-100 text-orange-700">
                {pendingCount} need reminder
              </span>
            )}
          </p>
        </div>
        <button
          onClick={fetchCarts}
          disabled={loading}
          className="btn-secondary mt-1"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {/* ── Info callout ── */}
      {!loading && pendingCount === 0 && carts.length === 0 && (
        <div className="mb-6 card p-5 border-l-4 border-l-amber-400 bg-amber-50/50">
          <p className="text-sm font-medium text-amber-800">No checkouts tracked yet</p>
          <p className="text-sm text-amber-700 mt-1">
            Register <code className="bg-amber-100 px-1 rounded text-xs">checkouts/create</code> and{' '}
            <code className="bg-amber-100 px-1 rounded text-xs">checkouts/update</code> webhooks in
            your Shopify admin. Abandoned carts older than 1 hour will appear here automatically.
          </p>
        </div>
      )}

      {/* ── Table ── */}
      <div className="card overflow-hidden">
        <DataTable
          columns={columns}
          data={carts}
          loading={loading}
          emptyMessage="No checkouts tracked yet. Register Shopify checkout webhooks to start monitoring."
          keyField="checkoutId"
        />
      </div>
    </div>
  );
}
