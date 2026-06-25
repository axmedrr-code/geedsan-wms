'use client';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Gauge, Wifi, WifiOff, Droplets, AlertTriangle, Battery,
  TrendingUp, TrendingDown, Activity, RefreshCw, Users, Zap
} from 'lucide-react';
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend
} from 'recharts';
import { dashboardAPI } from '../../lib/api';
import { format } from 'date-fns';
import Link from 'next/link';

const SEVERITY_COLORS = {
  critical: '#ef4444',
  warning: '#f59e0b',
  info: '#3b82f6'
};

const ALARM_TYPE_LABELS = {
  low_battery: 'Low Battery',
  valve_failure: 'Valve Failure',
  magnetic_attack: 'Magnetic Attack',
  water_leakage: 'Water Leakage',
  reverse_flow: 'Reverse Flow',
  pipe_burst: 'Pipe Burst',
  communication_loss: 'Comm. Loss'
};

function StatCard({ icon: Icon, label, value, sub, color = 'primary', trend }) {
  const colors = {
    primary: 'from-primary-500/20 to-primary-600/5 border-primary-500/20 text-primary-400',
    green:   'from-emerald-500/20 to-emerald-600/5 border-emerald-500/20 text-emerald-400',
    red:     'from-red-500/20 to-red-600/5 border-red-500/20 text-red-400',
    amber:   'from-amber-500/20 to-amber-600/5 border-amber-500/20 text-amber-400',
    purple:  'from-purple-500/20 to-purple-600/5 border-purple-500/20 text-purple-400',
    cyan:    'from-cyan-500/20 to-cyan-600/5 border-cyan-500/20 text-cyan-400',
  };

  return (
    <div className={`relative overflow-hidden bg-gradient-to-br ${colors[color]} border rounded-xl p-5`}>
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs font-medium text-slate-400 uppercase tracking-wider">{label}</p>
          <p className="text-3xl font-bold text-white mt-1.5 font-display">{value ?? '—'}</p>
          {sub && <p className="text-xs text-slate-500 mt-1">{sub}</p>}
        </div>
        <div className="p-2.5 rounded-xl bg-current/10">
          <Icon className="w-5 h-5" />
        </div>
      </div>
      {trend !== undefined && (
        <div className="flex items-center gap-1 mt-3 text-xs">
          {trend >= 0
            ? <TrendingUp className="w-3 h-3 text-emerald-400" />
            : <TrendingDown className="w-3 h-3 text-red-400" />}
          <span className={trend >= 0 ? 'text-emerald-400' : 'text-red-400'}>
            {Math.abs(trend)}% vs last week
          </span>
        </div>
      )}
    </div>
  );
}

const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-slate-900 border border-slate-700 rounded-lg p-3 text-sm shadow-xl">
      <p className="text-slate-400 mb-1.5">{label}</p>
      {payload.map((p, i) => (
        <div key={i} className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full" style={{ background: p.color }} />
          <span className="text-slate-300">{p.name}:</span>
          <span className="text-white font-medium">{Number(p.value).toFixed(2)}</span>
        </div>
      ))}
    </div>
  );
};

export default function DashboardPage() {
  const [refreshKey, setRefreshKey] = useState(0);

  const { data: stats, isLoading: statsLoading } = useQuery({
    queryKey: ['dashboard-stats', refreshKey],
    queryFn: () => dashboardAPI.getStats().then(r => r.data),
    refetchInterval: 30000
  });

  const { data: chartData } = useQuery({
    queryKey: ['consumption-chart', refreshKey],
    queryFn: () => dashboardAPI.getConsumptionChart(14).then(r => r.data),
    refetchInterval: 60000
  });

  const { data: recentAlarms } = useQuery({
    queryKey: ['recent-alarms', refreshKey],
    queryFn: () => dashboardAPI.getRecentAlarms().then(r => r.data),
    refetchInterval: 30000
  });

  const { data: distribution } = useQuery({
    queryKey: ['distribution', refreshKey],
    queryFn: () => dashboardAPI.getDistribution().then(r => r.data),
    refetchInterval: 60000
  });

  const { data: topConsumers } = useQuery({
    queryKey: ['top-consumers', refreshKey],
    queryFn: () => dashboardAPI.getTopConsumers().then(r => r.data),
    refetchInterval: 60000
  });

  const batteryData = distribution?.battery || [];
  const batteryColors = { good: '#7ED957', medium: '#f59e0b', low: '#f97316', critical: '#ef4444', unknown: '#64748b' };

  const valveData = distribution?.valve || [];
  const valveColors = { open: '#7ED957', closed: '#ef4444', unknown: '#64748b', fault: '#f97316' };

  return (
    <div className="p-4 lg:p-6 space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white font-display">Dashboard</h1>
          <p className="text-slate-400 text-sm mt-0.5">
            {format(new Date(), 'EEEE, MMMM d, yyyy • HH:mm')}
          </p>
        </div>
        <button
          onClick={() => setRefreshKey(k => k + 1)}
          className="btn-ghost text-xs"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Refresh
        </button>
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
        <StatCard
          icon={Gauge}
          label="Total Meters"
          value={stats?.total_meters}
          sub="Active devices"
          color="primary"
        />
        <StatCard
          icon={Wifi}
          label="Online"
          value={stats?.online_meters}
          sub={`${stats?.total_meters > 0 ? Math.round((stats?.online_meters / stats?.total_meters) * 100) : 0}% uptime`}
          color="green"
        />
        <StatCard
          icon={WifiOff}
          label="Offline"
          value={stats?.offline_meters}
          sub="Needs attention"
          color="red"
        />
        <StatCard
          icon={Droplets}
          label="Total Flow"
          value={stats?.total_consumption ? `${Number(stats.total_consumption).toFixed(0)}` : '0'}
          sub="m³ cumulative"
          color="cyan"
        />
        <StatCard
          icon={AlertTriangle}
          label="Active Alarms"
          value={stats?.active_alarms}
          sub={`${stats?.critical_alarms || 0} critical`}
          color="amber"
        />
        <StatCard
          icon={Battery}
          label="Low Battery"
          value={stats?.low_battery_count}
          sub="Need replacement"
          color="purple"
        />
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* Consumption Chart */}
        <div className="xl:col-span-2 card-glow p-5">
          <div className="flex items-center justify-between mb-5">
            <div>
              <h3 className="font-semibold text-white">Consumption Trend</h3>
              <p className="text-xs text-slate-500 mt-0.5">Last 14 days (m³)</p>
            </div>
            <Activity className="w-4 h-4 text-slate-500" />
          </div>
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={chartData || []} margin={{ top: 5, right: 5, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="flowGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#42A5F5" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#42A5F5" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
              <XAxis dataKey="date" tick={{ fill: '#64748b', fontSize: 10 }} tickFormatter={d => d ? format(new Date(d), 'MMM d') : ''} />
              <YAxis tick={{ fill: '#64748b', fontSize: 10 }} />
              <Tooltip content={<CustomTooltip />} />
              <Area type="monotone" dataKey="total_flow" name="Flow" stroke="#42A5F5" fill="url(#flowGradient)" strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        {/* Battery Distribution */}
        <div className="card-glow p-5">
          <h3 className="font-semibold text-white mb-1">Battery Status</h3>
          <p className="text-xs text-slate-500 mb-4">Distribution across fleet</p>
          <ResponsiveContainer width="100%" height={160}>
            <PieChart>
              <Pie
                data={batteryData}
                dataKey="count"
                nameKey="level"
                cx="50%"
                cy="50%"
                innerRadius={45}
                outerRadius={70}
                paddingAngle={3}
              >
                {batteryData.map((entry, i) => (
                  <Cell key={i} fill={batteryColors[entry.level] || '#64748b'} />
                ))}
              </Pie>
              <Tooltip contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8 }} />
            </PieChart>
          </ResponsiveContainer>
          <div className="space-y-1.5 mt-2">
            {batteryData.map((item, i) => (
              <div key={i} className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full" style={{ background: batteryColors[item.level] || '#64748b' }} />
                  <span className="text-slate-400 capitalize">{item.level}</span>
                </div>
                <span className="text-white font-medium">{item.count}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Bottom Row */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {/* Recent Alarms */}
        <div className="card-glow p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold text-white">Active Alarms</h3>
            <Link href="/dashboard/alarms" className="text-xs text-primary-400 hover:text-primary-300">
              View all →
            </Link>
          </div>
          {!recentAlarms?.length ? (
            <div className="flex flex-col items-center justify-center py-8 text-slate-500">
              <AlertTriangle className="w-8 h-8 mb-2 opacity-30" />
              <p className="text-sm">No active alarms</p>
            </div>
          ) : (
            <div className="space-y-2">
              {(recentAlarms || []).slice(0, 6).map(alarm => (
                <div key={alarm.id} className="flex items-start gap-3 p-3 rounded-lg bg-slate-800/50 border border-slate-700/50">
                  <div className={`w-2 h-2 rounded-full mt-1.5 flex-shrink-0 ${
                    alarm.severity === 'critical' ? 'bg-red-400' :
                    alarm.severity === 'warning' ? 'bg-amber-400' : 'bg-blue-400'
                  }`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-white">
                        {ALARM_TYPE_LABELS[alarm.alarm_type] || alarm.alarm_type}
                      </span>
                      <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${
                        alarm.severity === 'critical' ? 'bg-red-500/10 text-red-400' :
                        alarm.severity === 'warning' ? 'bg-amber-500/10 text-amber-400' : 'bg-blue-500/10 text-blue-400'
                      }`}>{alarm.severity}</span>
                    </div>
                    <p className="text-xs text-slate-500 mt-0.5 truncate">
                      {alarm.meter_number} · {alarm.customer_name || 'Unknown'}
                    </p>
                    <p className="text-xs text-slate-600 mt-0.5">
                      {alarm.triggered_at ? format(new Date(alarm.triggered_at), 'MMM d, HH:mm') : ''}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Top Consumers */}
        <div className="card-glow p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold text-white">Top Consumers</h3>
            <Link href="/dashboard/meters" className="text-xs text-primary-400 hover:text-primary-300">
              View all →
            </Link>
          </div>
          {!topConsumers?.length ? (
            <div className="flex flex-col items-center justify-center py-8 text-slate-500">
              <Droplets className="w-8 h-8 mb-2 opacity-30" />
              <p className="text-sm">No data available</p>
            </div>
          ) : (
            <div className="space-y-2">
              {(topConsumers || []).slice(0, 6).map((m, i) => (
                <Link key={m.id} href={`/dashboard/meters/${m.id}`}>
                  <div className="flex items-center gap-3 p-2.5 rounded-lg hover:bg-slate-800/50 transition-colors">
                    <span className="text-xs text-slate-500 w-4 text-center font-medium">{i + 1}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium text-white truncate">{m.meter_number}</span>
                        <span className="text-sm font-bold text-primary-400">{Number(m.total_consumption).toFixed(1)} m³</span>
                      </div>
                      <p className="text-xs text-slate-500 truncate">{m.customer_name || 'No customer'}</p>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
