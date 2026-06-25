'use client';
import { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';
import { useAuthStore } from '../../store/authStore';
import {
  LayoutDashboard, Gauge, AlertTriangle, Users, FileBarChart,
  Brain, Bell, Settings, LogOut, Droplets, Menu, X,
  ChevronLeft, Shield
} from 'lucide-react';
import { clsx } from 'clsx';

const NAV = [
  { href: '/dashboard',               icon: LayoutDashboard, label: 'Dashboard',      roles: ['admin','operator','viewer'] },
  { href: '/dashboard/meters',        icon: Gauge,           label: 'Meters',         roles: ['admin','operator','viewer'] },
  { href: '/dashboard/alarms',        icon: AlertTriangle,   label: 'Alarms',         roles: ['admin','operator','viewer'] },
  { href: '/dashboard/customers',     icon: Users,           label: 'Customers',      roles: ['admin','operator','viewer'] },
  { href: '/dashboard/reports',       icon: FileBarChart,    label: 'Reports',        roles: ['admin','operator','viewer'] },
  { href: '/dashboard/ai',            icon: Brain,           label: 'AI Analytics',   roles: ['admin','operator','viewer'] },
  { href: '/dashboard/notifications', icon: Bell,            label: 'Notifications',  roles: ['admin','operator'] },
  { href: '/dashboard/users',         icon: Shield,          label: 'Users',          roles: ['admin'] },
  { href: '/dashboard/settings',      icon: Settings,        label: 'Settings',       roles: ['admin'] },
];

export default function DashboardLayout({ children }) {
  const { user, logout, initialize, isInitialized } = useAuthStore();
  const router = useRouter();
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    initialize().then(() => {
      const { user } = useAuthStore.getState();
      if (!user) router.replace('/login');
    });
  }, []);

  if (!isInitialized) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="w-8 h-8 border-2 border-primary-500/30 border-t-primary-500 rounded-full animate-spin" />
      </div>
    );
  }

  if (!user) return null;

  const visibleNav = NAV.filter(n => n.roles.includes(user.role));

  const SidebarContent = () => (
    <div className="flex flex-col h-full">
      {/* Brand */}
      <div className={clsx('p-4 border-b border-slate-800', collapsed ? 'px-2' : '')}>
        <div className={clsx('flex items-center gap-3', collapsed && 'justify-center')}>
          <div className="w-8 h-8 bg-primary-500/20 border border-primary-500/30 rounded-lg flex items-center justify-center flex-shrink-0">
            <Droplets className="w-4 h-4 text-primary-400" />
          </div>
          {!collapsed && (
            <div>
              <p className="font-bold text-white text-sm font-display">GEEDSAN</p>
              <p className="text-slate-500 text-xs">WMS v1.0</p>
            </div>
          )}
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 p-2 space-y-1 overflow-y-auto">
        {visibleNav.map(item => {
          const isActive = pathname === item.href || (item.href !== '/dashboard' && pathname.startsWith(item.href));
          return (
            <Link key={item.href} href={item.href} onClick={() => setMobileOpen(false)}
              className={clsx('sidebar-item', isActive && 'active', collapsed && 'justify-center px-2')}>
              <item.icon className="w-4 h-4 flex-shrink-0" />
              {!collapsed && <span>{item.label}</span>}
            </Link>
          );
        })}
      </nav>

      {/* User */}
      <div className={clsx('p-3 border-t border-slate-800', collapsed && 'px-2')}>
        <div className={clsx('flex items-center gap-3 mb-2', collapsed && 'justify-center')}>
          <div className="w-7 h-7 rounded-full bg-gradient-to-br from-primary-400 to-primary-700 flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
            {user.fullName?.[0]}
          </div>
          {!collapsed && (
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-white truncate">{user.fullName}</p>
              <p className="text-xs text-slate-500 capitalize">{user.role}</p>
            </div>
          )}
        </div>
        <button onClick={logout} className={clsx('sidebar-item w-full hover:text-red-400', collapsed && 'justify-center px-2')}>
          <LogOut className="w-4 h-4 flex-shrink-0" />
          {!collapsed && <span>Sign Out</span>}
        </button>
      </div>
    </div>
  );

  return (
    <div className="flex h-screen overflow-hidden bg-slate-950">
      {/* Desktop sidebar */}
      <aside className={clsx('hidden lg:flex flex-col flex-shrink-0 bg-slate-900/80 border-r border-slate-800 transition-all duration-200', collapsed ? 'w-14' : 'w-56')}>
        <SidebarContent />
        <button onClick={() => setCollapsed(c => !c)} className="absolute left-0 bottom-20 p-1 bg-slate-800 border border-slate-700 rounded-r-lg text-slate-400 hover:text-white" style={{ left: collapsed ? 48 : 208 }}>
          <ChevronLeft className={clsx('w-3 h-3 transition-transform', collapsed && 'rotate-180')} />
        </button>
      </aside>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div className="lg:hidden fixed inset-0 z-40">
          <div className="absolute inset-0 bg-black/60" onClick={() => setMobileOpen(false)} />
          <aside className="absolute left-0 top-0 bottom-0 w-56 bg-slate-900 border-r border-slate-800 z-50">
            <SidebarContent />
          </aside>
        </div>
      )}

      {/* Main */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Mobile header */}
        <header className="lg:hidden flex items-center gap-3 p-4 border-b border-slate-800 bg-slate-900/50">
          <button onClick={() => setMobileOpen(true)} className="text-slate-400 hover:text-white">
            <Menu className="w-5 h-5" />
          </button>
          <div className="flex items-center gap-2">
            <Droplets className="w-4 h-4 text-primary-400" />
            <span className="font-bold text-sm font-display">GEEDSAN WMS</span>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
