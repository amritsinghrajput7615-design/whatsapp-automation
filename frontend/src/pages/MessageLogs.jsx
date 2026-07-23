import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, Filter } from 'lucide-react';
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

function truncate(str, n = 60) {
  if (!str) return '—';
  return str.length > n ? str.slice(0, n) + '…' : str;
}

const STATUS_OPTIONS = [
  { value: 'all',    label: 'All statuses' },
  { value: 'sent',   label: 'Sent' },
  { value: 'failed', label: 'Failed' },
];

export default function MessageLogs() {
  const [messages, setMessages] = useState([]);
  const [total, setTotal]       = useState(0);
  const [loading, setLoading]   = useState(true);
  const [page, setPage]         = useState(1);

  // Filters
  const [status, setStatus]         = useState('all');
  const [startDate, setStartDate]   = useState('');
  const [endDate, setEndDate]       = useState('');

  const LIMIT = 100;

  const fetchMessages = useCallback(async (p = 1) => {
    setLoading(true);
    try {
      const params = { page: p, limit: LIMIT };
      if (status !== 'all') params.status = status;
      if (startDate) params.startDate = startDate;
      if (endDate)   params.endDate   = endDate;

      const data = await api.getMessages(params);
      setMessages(data.messages);
      setTotal(data.total);
    } catch (err) {
      toast.error(`Failed to load messages: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, [status, startDate, endDate]);

  useEffect(() => {
    setPage(1);
    fetchMessages(1);
  }, [fetchMessages]);

  const columns = [
    {
      key: 'to',
      label: 'Recipient',
      render: (v) => (
        <span className="font-mono text-xs text-gray-700">{v || '—'}</span>
      ),
    },
    {
      key: 'type',
      label: 'Type',
      render: (v) => <StatusBadge status={v} />,
    },
    {
      key: 'status',
      label: 'Status',
      render: (v) => <StatusBadge status={v} />,
    },
    {
      key: 'message',
      label: 'Message preview',
      render: (v) => (
        <span
          className="text-xs text-gray-500"
          title={v}
        >
          {truncate(v, 55)}
        </span>
      ),
    },
    {
      key: 'error',
      label: 'Error',
      render: (v) =>
        v ? (
          <span className="text-xs text-red-500" title={v}>
            {truncate(v, 50)}
          </span>
        ) : (
          <span className="text-xs text-gray-300">—</span>
        ),
    },
    {
      key: 'timestamp',
      label: 'Timestamp',
      render: (v) => (
        <span className="text-xs text-gray-400 whitespace-nowrap">{formatDate(v)}</span>
      ),
    },
  ];

  const pages = Math.ceil(total / LIMIT);

  return (
    <div className="p-8 animate-slide-up">
      {/* ── Header ── */}
      <div className="page-header">
        <h1 className="page-title">Message Logs</h1>
        <p className="page-subtitle">
          All WhatsApp messages sent by this server — {total} total
        </p>
      </div>

      {/* ── Filters ── */}
      <div className="card p-4 mb-5 flex flex-wrap gap-3 items-end">
        <div className="flex items-center gap-2 text-sm text-gray-500 mr-1">
          <Filter size={14} />
          Filters:
        </div>

        {/* Status */}
        <div>
          <label className="block text-xs text-gray-400 mb-1">Status</label>
          <select
            id="filter-status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="input py-1.5 w-36 text-sm"
          >
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>

        {/* Start date */}
        <div>
          <label className="block text-xs text-gray-400 mb-1">From</label>
          <input
            id="filter-start-date"
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="input py-1.5 w-36 text-sm"
          />
        </div>

        {/* End date */}
        <div>
          <label className="block text-xs text-gray-400 mb-1">To</label>
          <input
            id="filter-end-date"
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className="input py-1.5 w-36 text-sm"
          />
        </div>

        <button
          onClick={() => { setStatus('all'); setStartDate(''); setEndDate(''); }}
          className="btn-secondary py-1.5 px-3 text-xs self-end"
        >
          Clear
        </button>

        <div className="ml-auto self-end">
          <button
            onClick={() => fetchMessages(1)}
            disabled={loading}
            className="btn-secondary py-1.5 px-3 text-xs"
          >
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>
      </div>

      {/* ── Table ── */}
      <div className="card overflow-hidden">
        <DataTable
          columns={columns}
          data={messages}
          loading={loading}
          emptyMessage="No messages match the current filters."
          keyField="id"
        />
      </div>

      {/* ── Pagination ── */}
      {pages > 1 && (
        <div className="mt-4 flex items-center justify-between text-sm text-gray-500">
          <span>Page {page} of {pages}</span>
          <div className="flex gap-2">
            <button
              disabled={page <= 1}
              onClick={() => { const p = page - 1; setPage(p); fetchMessages(p); }}
              className="btn-secondary py-1.5 px-3 text-xs"
            >
              Previous
            </button>
            <button
              disabled={page >= pages}
              onClick={() => { const p = page + 1; setPage(p); fetchMessages(p); }}
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
