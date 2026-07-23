import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, RotateCcw } from 'lucide-react';
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

export default function Orders() {
  const [orders, setOrders]     = useState([]);
  const [total, setTotal]       = useState(0);
  const [loading, setLoading]   = useState(true);
  const [resending, setResending] = useState(null); // order id being resent
  const [page, setPage]         = useState(1);
  const LIMIT = 50;

  const fetchOrders = useCallback(async (p = 1) => {
    setLoading(true);
    try {
      const data = await api.getOrders({ page: p, limit: LIMIT });
      setOrders(data.orders);
      setTotal(data.total);
    } catch (err) {
      toast.error(`Failed to load orders: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchOrders(page); }, [fetchOrders, page]);

  const handleResend = async (orderId, orderNumber) => {
    setResending(orderId);
    try {
      const result = await api.resendOrder(orderId);
      if (result.success) {
        toast.success(`Message resent for order #${orderNumber}!`);
        // Update row in place
        setOrders((prev) =>
          prev.map((o) =>
            o.id === orderId ? { ...o, whatsappStatus: 'sent' } : o
          )
        );
      } else {
        toast.error(`Resend failed: ${result.error}`);
      }
    } catch (err) {
      toast.error(err.message);
    } finally {
      setResending(null);
    }
  };

  const columns = [
    {
      key: 'orderNumber',
      label: 'Order #',
      render: (v) => (
        <span className="font-semibold text-gray-900">#{v}</span>
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
      key: 'total',
      label: 'Total',
      render: (v) => <span className="font-medium">{v}</span>,
    },
    {
      key: 'whatsappStatus',
      label: 'WhatsApp',
      render: (v) => <StatusBadge status={v} />,
    },
    {
      key: 'timestamp',
      label: 'Date',
      render: (v) => (
        <span className="text-xs text-gray-400">{formatDate(v)}</span>
      ),
    },
    {
      key: 'id',
      label: 'Action',
      render: (id, row) => (
        <button
          id={`resend-order-${id}`}
          disabled={resending === id || !row.phone}
          onClick={() => handleResend(id, row.orderNumber)}
          className="btn-secondary text-xs py-1.5 px-3"
          title={!row.phone ? 'No phone number on this order' : 'Resend WhatsApp message'}
        >
          <RotateCcw size={12} className={resending === id ? 'animate-spin' : ''} />
          {resending === id ? 'Sending…' : 'Resend'}
        </button>
      ),
    },
  ];

  const pages = Math.ceil(total / LIMIT);

  return (
    <div className="p-8 animate-slide-up">
      {/* ── Header ── */}
      <div className="page-header flex items-start justify-between">
        <div>
          <h1 className="page-title">Orders</h1>
          <p className="page-subtitle">
            {total} order{total !== 1 ? 's' : ''} received via Shopify webhook
          </p>
        </div>
        <button
          onClick={() => fetchOrders(page)}
          disabled={loading}
          className="btn-secondary mt-1"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {/* ── Table ── */}
      <div className="card overflow-hidden">
        <DataTable
          columns={columns}
          data={orders}
          loading={loading}
          emptyMessage="No orders yet. Shopify will send data here when orders are placed."
          keyField="id"
        />
      </div>

      {/* ── Pagination ── */}
      {pages > 1 && (
        <div className="mt-4 flex items-center justify-between text-sm text-gray-500">
          <span>
            Page {page} of {pages} ({total} orders)
          </span>
          <div className="flex gap-2">
            <button
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
              className="btn-secondary py-1.5 px-3 text-xs"
            >
              Previous
            </button>
            <button
              disabled={page >= pages}
              onClick={() => setPage((p) => p + 1)}
              className="btn-secondary py-1.5 px-3 text-xs"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
