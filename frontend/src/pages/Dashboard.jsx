import { useState, useEffect, useCallback } from 'react';
import {
  ShoppingBag,
  ShoppingCart,
  MessageCircle,
  AlertCircle,
  RefreshCw,
} from 'lucide-react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import toast from 'react-hot-toast';
import { api } from '../api/endpoints';
import { StatCard } from '../components/StatCard';

const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-slate-900 border border-slate-700 rounded-xl px-4 py-3 shadow-xl text-xs">
      <p className="text-slate-400 mb-2 font-medium">{label}</p>
      {payload.map((p) => (
        <p key={p.name} style={{ color: p.color }} className="font-semibold">
          {p.name}: {p.value}
        </p>
      ))}
    </div>
  );
};

export default function Dashboard() {
  const [stats, setStats]     = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchStats = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    else setRefreshing(true);
    try {
      const data = await api.getStats();
      setStats(data);
    } catch (err) {
      toast.error(`Failed to load stats: ${err.message}`);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchStats();
    const interval = setInterval(() => fetchStats(true), 30_000);
    return () => clearInterval(interval);
  }, [fetchStats]);

  const cards = [
    {
      title:     'Orders Today',
      value:     stats?.ordersToday ?? 0,
      icon:      ShoppingBag,
      iconBg:    'bg-blue-50',
      iconColor: 'text-blue-600',
      subtitle:  'New Shopify orders',
    },
    {
      title:     'Abandoned Carts',
      value:     stats?.abandonedCarts ?? 0,
      icon:      ShoppingCart,
      iconBg:    'bg-orange-50',
      iconColor: 'text-orange-500',
      subtitle:  'Awaiting reminder',
    },
    {
      title:     'Messages Sent',
      value:     stats?.messagesSent ?? 0,
      icon:      MessageCircle,
      iconBg:    'bg-emerald-50',
      iconColor: 'text-emerald-600',
      subtitle:  'All time via WhatsApp',
    },
    {
      title:     'Messages Failed',
      value:     stats?.messagesFailed ?? 0,
      icon:      AlertCircle,
      iconBg:    'bg-red-50',
      iconColor: 'text-red-500',
      subtitle:  'Delivery errors',
    },
  ];

  const chartData = (stats?.messagesPerDay || []).map((d) => ({
    ...d,
    date: new Date(d.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
  }));

  return (
    <div className="p-8 animate-slide-up">
      {/* ── Header ── */}
      <div className="page-header flex items-start justify-between">
        <div>
          <h1 className="page-title">Dashboard</h1>
          <p className="page-subtitle">
            Real-time overview of your Shopify × WhatsApp automation
          </p>
        </div>
        <button
          onClick={() => fetchStats(true)}
          disabled={refreshing}
          className="btn-secondary mt-1"
          title="Refresh stats"
        >
          <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {/* ── Stat Cards ── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-5 mb-8">
        {cards.map((c) => (
          <StatCard key={c.title} {...c} loading={loading} />
        ))}
      </div>

      {/* ── Chart ── */}
      <div className="card p-6 animate-fade-in">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-base font-semibold text-gray-900">
              Messages per Day
            </h2>
            <p className="text-sm text-gray-400">Last 7 days</p>
          </div>
          <div className="flex items-center gap-4 text-xs text-gray-500">
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-0.5 rounded-full bg-whatsapp-500 inline-block" />
              Sent
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-0.5 rounded-full bg-red-400 inline-block" />
              Failed
            </span>
          </div>
        </div>

        {loading ? (
          <div className="h-64 skeleton rounded-xl" />
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            <AreaChart data={chartData} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
              <defs>
                <linearGradient id="colorSent" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor="#25D366" stopOpacity={0.2} />
                  <stop offset="95%" stopColor="#25D366" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="colorFailed" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor="#f87171" stopOpacity={0.2} />
                  <stop offset="95%" stopColor="#f87171" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" vertical={false} />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 11, fill: '#9ca3af' }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                tick={{ fontSize: 11, fill: '#9ca3af' }}
                axisLine={false}
                tickLine={false}
                allowDecimals={false}
              />
              <Tooltip content={<CustomTooltip />} />
              <Area
                type="monotone"
                dataKey="sent"
                name="Sent"
                stroke="#25D366"
                strokeWidth={2.5}
                fill="url(#colorSent)"
                dot={{ r: 3, fill: '#25D366', strokeWidth: 0 }}
                activeDot={{ r: 5 }}
              />
              <Area
                type="monotone"
                dataKey="failed"
                name="Failed"
                stroke="#f87171"
                strokeWidth={2}
                fill="url(#colorFailed)"
                dot={{ r: 3, fill: '#f87171', strokeWidth: 0 }}
                activeDot={{ r: 5 }}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* ── Auto-refresh note ── */}
      <p className="mt-4 text-center text-xs text-gray-300">
        Stats auto-refresh every 30 seconds
      </p>
    </div>
  );
}
