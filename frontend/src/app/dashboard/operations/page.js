'use client';
import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { dashboardAPI } from '../../../lib/api';
import {
  Wifi, WifiOff, Activity, Battery, Radio, Gauge, Droplets,
  Lock, Unlock, AlertTriangle, CheckCircle, Zap, TrendingUp, TrendingDown,
  RefreshCw, Clock
} from 'lucide-react';

const fmt = (v, decimals = 1) => v != null ? Number(v).toFixed(decimals) : '—';
const pct = (v) => v != null ? `${v}%` : '—';

function StatCard({ icon: Icon, label, value, unit = '', color = 'blue', sub }) {
  const colors = {
    blue:   'text-blue-400 bg-blue-500/10 border-blue-500/20',
    green:  'text-green-400 bg-green-500/10 border-green-500/20',
    red:    'text-red-400 bg-red-500/10 border-red-500/20',
    yellow: 'text-yellow-400 bg-yellow-500/10 border-yellow-500/20',
    purple: 'text-purple-400 bg-purple-500/10 border-purple-500/20',
    cyan:   'text-cyan-400 bg-cyan-500/10 border-cyan-500/20',
    orange: 'text-orange-400 bg-orange-500/10 border-orange-500/20',
    slate:  'text-slate-400 bg-slate-500/10 border-slate-500/20',
  };
  return (
    <div className={`rounded-xl border p-4 flex flex-col gap-2 ${colors[color]}`}>
      <div className="flex items-center gap-2 text-sm font-medium opacity-80">
        <Icon className="w-4 h-4" />
        {label}
      </div>
      <div className="text-2xl font-bold text-white">
        {value}{unit && <span className="text-sm font-normal ml-1 opacity-60">{unit}</span>}
      </div>
      {sub && <p className="text-xs opacity-60">{sub}</p>}
    </div>
  );
}

export default function OperationsPage() {
  const { data, isLoading, isError, refetch, dataUpdatedAt } = useQuery({
    queryKey: ['ops-stats'],
    queryFn: () => dashboardAPI.getOpsStats().then(r => r.data),
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  const lastUpdate = dataUpdatedAt ? new Date(dataUpdatedAt).toLocaleTimeString() : null;

  if (isLoading) return (
    <div className="p-6 flex items-center gap-3 text-slate-400">
      <RefreshCw className="w-5 h-5 animate-spin" /> Loading live operations data…
    </div>
  );

  if (isError) return (
    <div className="p-6 text-red-400">Failed to load operations data. Check backend connection.</div>
  );

  const d = data || {};
  const commOk = d.comm_success_rate_pct != null;

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white">Live Operations Dashboard</h1>
          <p className="text-slate-400 text-sm mt-0.5">Real-time fleet status — auto-refreshes every 30 s</p>
        </div>
        <div className="flex items-center gap-3">
          {d.cached && (
            <span className="text-xs text-yellow-400 bg-yellow-500/10 border border-yellow-500/20 px-2 py-1 rounded">
              Cached
            </span>
          )}
          <button onClick={() => refetch()} className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-white border border-slate-700 hover:border-slate-500 px-3 py-1.5 rounded-lg transition-colors">
            <RefreshCw className="w-3.5 h-3.5" /> Refresh
          </button>
          {lastUpdate && (
            <div className="flex items-center gap-1 text-xs text-slate-500">
              <Clock className="w-3.5 h-3.5" /> {lastUpdate}
            </div>
          )}
        </div>
      </div>

      {/* Section: Connectivity */}
      <section>
        <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Connectivity</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard icon={Wifi}    label="Online Meters"          value={d.online_meters ?? '—'}         color="green"
            sub={`of ${d.total_active_meters ?? '—'} active`} />
          <StatCard icon={WifiOff} label="Offline Meters"         value={d.offline_meters ?? '—'}        color="red" />
          <StatCard icon={Activity}label="Reporting Today"        value={d.meters_reporting_today ?? '—'}color="blue"
            sub="last 25 hours" />
          <StatCard icon={CheckCircle} label="Comm Success Rate"  value={commOk ? d.comm_success_rate_pct : '—'} unit={commOk ? '%' : ''} color="cyan"
            sub="24-hour packet rate" />
        </div>
      </section>

      {/* Section: Device Health */}
      <section>
        <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Device Health</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard icon={Battery} label="Avg Battery"    value={d.avg_battery_pct != null ? d.avg_battery_pct : '—'} unit={d.avg_battery_pct != null ? '%' : ''} color="yellow" />
          <StatCard icon={Radio}   label="Avg RSSI"       value={d.avg_rssi_dbm != null ? fmt(d.avg_rssi_dbm) : '—'} unit={d.avg_rssi_dbm != null ? ' dBm' : ''} color="purple" />
          <StatCard icon={Gauge}   label="Avg Pressure"   value={d.avg_pressure_bar != null ? fmt(d.avg_pressure_bar, 2) : '—'} unit={d.avg_pressure_bar != null ? ' bar' : ''} color="blue" />
          <StatCard icon={Zap}     label="Current Flow"   value={d.current_flow_lpm != null ? fmt(d.current_flow_lpm) : '—'} unit={d.current_flow_lpm != null ? ' L/m' : ''} color="cyan"
            sub="online meters" />
        </div>
      </section>

      {/* Section: Valves */}
      <section>
        <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Valve Status</h2>
        <div className="grid grid-cols-2 md:grid-cols-2 gap-3">
          <StatCard icon={Unlock} label="Open Valves"   value={d.open_valves ?? '—'}   color="green" />
          <StatCard icon={Lock}   label="Closed Valves" value={d.closed_valves ?? '—'} color="slate" />
        </div>
      </section>

      {/* Section: Alerts */}
      <section>
        <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Active Alerts</h2>
        <div className="grid grid-cols-2 gap-3">
          <StatCard icon={AlertTriangle} label="Critical Alarms" value={d.critical_alarms ?? '—'} color={d.critical_alarms > 0 ? 'red' : 'green'} />
          <StatCard icon={Droplets}      label="Leaks Today"     value={d.leaks_today ?? '—'}     color={d.leaks_today > 0 ? 'orange' : 'green'} />
        </div>
      </section>

      {/* Section: Water Balance */}
      <section>
        <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Water Balance (Yesterday)</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <StatCard icon={TrendingUp}   label="Water Produced" value={fmt(d.water_produced_m3, 3)} unit=" m³" color="blue" />
          <StatCard icon={TrendingDown} label="Water Sold"     value={fmt(d.water_sold_m3, 3)}     unit=" m³" color="green" />
          <StatCard icon={Droplets}     label="Non-Revenue Water" value={d.non_revenue_water_pct != null ? d.non_revenue_water_pct : '—'} unit={d.non_revenue_water_pct != null ? '%' : ''} color={d.non_revenue_water_pct > 20 ? 'red' : 'yellow'} sub="NRW target <20%" />
        </div>
      </section>
    </div>
  );
}
