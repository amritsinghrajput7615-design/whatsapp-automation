import { NavLink, useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  ShoppingBag,
  ShoppingCart,
  MessageSquare,
  Settings,
  Zap,
} from 'lucide-react';

const NAV_ITEMS = [
  { to: '/dashboard',      label: 'Dashboard',       icon: LayoutDashboard },
  { to: '/orders',         label: 'Orders',           icon: ShoppingBag },
  { to: '/abandoned-carts',label: 'Abandoned Carts',  icon: ShoppingCart },
  { to: '/message-logs',   label: 'Message Logs',     icon: MessageSquare },
  { to: '/settings',       label: 'Settings',         icon: Settings },
];

export default function Sidebar() {
  return (
    <aside className="w-64 h-screen flex flex-col bg-slate-900 text-white shrink-0 overflow-hidden">
      {/* ── Logo ── */}
      <div className="flex items-center gap-3 px-6 py-5 border-b border-slate-800">
        <div className="w-9 h-9 rounded-xl bg-whatsapp-500 flex items-center justify-center shrink-0">
          <Zap size={18} className="text-white" />
        </div>
        <div>
          <p className="text-sm font-bold leading-tight text-white">ShopChat</p>
          <p className="text-xs text-slate-400 leading-tight">WhatsApp Automation</p>
        </div>
      </div>

      {/* ── Navigation ── */}
      <nav className="flex-1 px-3 py-4 space-y-0.5 overflow-y-auto">
        <p className="px-3 mb-2 text-[10px] font-semibold uppercase tracking-widest text-slate-500">
          Main
        </p>
        {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-150 group ` +
              (isActive
                ? 'bg-whatsapp-500/15 text-whatsapp-400 border border-whatsapp-500/25'
                : 'text-slate-400 hover:bg-slate-800 hover:text-white border border-transparent')
            }
          >
            {({ isActive }) => (
              <>
                <Icon
                  size={17}
                  className={isActive ? 'text-whatsapp-400' : 'text-slate-500 group-hover:text-slate-300'}
                />
                {label}
              </>
            )}
          </NavLink>
        ))}
      </nav>

      {/* ── Footer ── */}
      <div className="px-5 py-4 border-t border-slate-800">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-whatsapp-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-whatsapp-500" />
          </span>
          <p className="text-xs text-slate-500">Server live</p>
        </div>
        <p className="mt-1 text-[10px] text-slate-600">v1.0.0 — ShopChat</p>
      </div>
    </aside>
  );
}
