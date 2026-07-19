'use client';
import { useState, useEffect, useMemo } from 'react';
import { useParams } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { metersAPI, downlinksAPI, aiAPI } from '../../../../lib/api';
import { useRealtimeEvents } from '../../../../lib/useRealtimeEvents';
import {
  ArrowLeft, Droplets, Battery, Signal, Clock, Gauge,
  AlertTriangle, CheckCircle, RefreshCw,
  Activity, Brain, Lock, Unlock, RotateCcw,
  Loader2, Info, FlaskConical, Radio, Inbox,
  TrendingUp, TrendingDown, Minus, ShieldAlert, Zap
} from 'lucide-react';
import {
  AreaChart, Area, BarChart, Bar, LineChart, Line, XAxis, YAxis,
  CartesianGrid, Tooltip, ResponsiveContainer
} from 'recharts';
import { format, formatDistanceToNow } from 'date-fns';
import toast from 'react-hot-toast';
import Link from 'next/link';
import { useAuthStore } from '../../../../store/authStore';

const ALARM_LABELS = {
  low_battery: 'Low Battery', valve_fault: 'Valve Fault',
  magnetic_attack: 'Magnetic Attack', battery_removed: 'Battery Removed', metering_fault: 'Metering Fault',
  water_leakage: 'Water Leakage', reverse_flow: 'Reverse Flow', pipe_burst: 'Pipe Burst',
  water_inlet_alarm: 'Water Inlet Alarm', water_return_alarm: 'Water Return Alarm', flow_alarm: 'Flow Alarm',
  communication_loss: 'Communication Loss',
  low_pressure: 'Low Pressure', high_pressure: 'High Pressure', abnormal_consumption: 'Abnormal Consumption'
};

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'readings', label: 'Readings History' },
  { key: 'diagnostics', label: 'Diagnostics' },
  { key: 'alarms', label: 'Alarms' },
  { key: 'consumption', label: 'Consumption' },
  { key: 'leaks', label: 'Leaks' },
  { key: 'valve', label: 'Valve Control' }
];

const LEAK_TYPE_LABELS = {
  continuous_flow: 'Continuous Flow',
  night_flow: 'Night Flow',
  abnormal_consumption: 'Abnormal Consumption',
  reverse_flow: 'Reverse Flow',
  burst_pipe: 'Burst Pipe',
  pressure_drop: 'Pressure Drop',
};

const SEVERITY_COLORS = {
  critical: 'text-red-400 bg-red-500/10 border-red-500/20',
  high:     'text-orange-400 bg-orange-500/10 border-orange-500/20',
  medium:   'text-amber-400 bg-amber-500/10 border-amber-500/20',
  low:      'text-blue-400 bg-blue-500/10 border-blue-500/20',
};

function ValveButton({ label, icon: Icon, onClick, loading, variant = 'secondary', disabled }) {
  const cls = {
    open: 'bg-emerald-600 hover:bg-emerald-700 text-white border-emerald-600',
    close: 'bg-red-600 hover:bg-red-700 text-white border-red-600',
    dredge: 'bg-amber-600 hover:bg-amber-700 text-white border-amber-600',
    secondary: 'bg-slate-700 hover:bg-slate-600 text-white border-slate-600'
  };

  return (
    <button
      onClick={onClick}
      disabled={loading || disabled}
      className={`flex items-center gap-2 px-5 py-2.5 rounded-lg border font-medium text-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed ${cls[variant]}`}
    >
      {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Icon className="w-4 h-4" />}
      {label}
    </button>
  );
}

// Browser-safe base64 -> hex (no Buffer global available client-side).
function base64ToHex(b64) {
  try {
    const binary = atob(b64);
    let hex = '';
    for (let i = 0; i < binary.length; i++) {
      hex += binary.charCodeAt(i).toString(16).padStart(2, '0');
    }
    return hex.toUpperCase();
  } catch {
    return '';
  }
}

function StatCard({ icon: Icon, label, value, color }) {
  return (
    <div className="card-glow p-4">
      <div className="flex items-center gap-2 mb-2">
        <Icon className={`w-4 h-4 ${color}`} />
        <span className="text-xs text-slate-500">{label}</span>
      </div>
      <p className={`text-xl font-bold font-mono ${color}`}>{value}</p>
    </div>
  );
}

export default function MeterDetailPage() {
  const { id } = useParams();
  const queryClient = useQueryClient();
  const { user } = useAuthStore();
  const [activeTab, setActiveTab] = useState('overview');
  const [activeCmd, setActiveCmd] = useState(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiResult, setAiResult] = useState(null);

  // Fake live telemetry — for UI testing only. Nudges a local overlay every
  // 10s so the page "feels" live even with no real device reporting. Never
  // written to the backend; purely a display-layer simulation, clearly
  // labeled and toggleable so it can't be mistaken for real readings.
  const [simulateLive, setSimulateLive] = useState(true);
  const [simOverlay, setSimOverlay] = useState(null);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['meter-detail', id],
    queryFn: () => metersAPI.get(id).then(r => r.data),
    refetchInterval: 30000
  });

  const { data: readingsData } = useQuery({
    queryKey: ['meter-readings', id],
    queryFn: () => metersAPI.getReadings(id, {
      from: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      interval: 'hour'
    }).then(r => r.data),
    enabled: !!id
  });

  const { data: signalData } = useQuery({
    queryKey: ['meter-signal', id],
    queryFn: () => metersAPI.getSignal(id, { hours: 72 }).then(r => r.data?.data || []),
    enabled: !!id
  });

  const { data: packetsData } = useQuery({
    queryKey: ['meter-packets', id],
    queryFn: () => metersAPI.getPackets(id, { limit: 50 }).then(r => r.data?.data || []),
    enabled: !!id
  });

  const [consumptionPeriod, setConsumptionPeriod] = useState('daily');
  const { data: consumptionData } = useQuery({
    queryKey: ['meter-consumption', id, consumptionPeriod],
    queryFn: () => metersAPI.getConsumption(id, { period: consumptionPeriod }).then(r => r.data),
    enabled: !!id && activeTab === 'consumption',
    staleTime: 60000
  });

  const { data: billingPeriodData } = useQuery({
    queryKey: ['meter-billing-period', id],
    queryFn: () => metersAPI.getBillingPeriodConsumption(id).then(r => r.data),
    enabled: !!id && activeTab === 'consumption',
    staleTime: 60000
  });

  const { data: healthData } = useQuery({
    queryKey: ['meter-health', id],
    queryFn: () => metersAPI.getHealth(id).then(r => r.data),
    enabled: !!id,
    staleTime: 120000
  });

  const { data: leaksData, refetch: refetchLeaks } = useQuery({
    queryKey: ['meter-leaks', id],
    queryFn: () => metersAPI.getLeaks(id).then(r => r.data),
    enabled: !!id && activeTab === 'leaks',
    staleTime: 30000
  });

  const resolveLeakMutation = useMutation({
    mutationFn: ({ leakId, status, notes }) => metersAPI.updateLeak(id, leakId, { status, notes }),
    onSuccess: () => { toast.success('Leak event updated'); refetchLeaks(); },
    onError: () => toast.error('Failed to update leak event')
  });

  const triggerLeakDetection = useMutation({
    mutationFn: () => metersAPI.detectLeaks(id),
    onSuccess: (res) => {
      toast.success(`Detection complete: ${res.data.detected} new event(s)`);
      refetchLeaks();
    },
    onError: () => toast.error('Leak detection failed')
  });

  useRealtimeEvents([['meter-detail', id], ['meter-readings', id], ['meter-signal', id], ['meter-packets', id]]);

  const meter = data?.meter;

  useEffect(() => {
    if (!simulateLive || !meter) { setSimOverlay(null); return; }
    const tick = () => {
      setSimOverlay({
        current_flow: Math.max(0, Number(meter.current_flow || 0) + (Math.random() - 0.5) * 2),
        pressure: Math.max(0, Number(meter.pressure || 300) + (Math.random() - 0.5) * 10),
        battery_voltage: Math.max(0, Number(meter.battery_voltage || 3.6) - Math.random() * 0.002),
        rssi: Math.round(Number(meter.rssi || -90) + (Math.random() - 0.5) * 6),
        updatedAt: new Date()
      });
    };
    tick();
    const interval = setInterval(tick, 10000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [simulateLive, meter?.id]);

  const display = useMemo(() => {
    if (!meter) return meter;
    if (!simOverlay) return meter;
    return { ...meter, ...simOverlay };
  }, [meter, simOverlay]);

  const sendCommand = useMutation({
    mutationFn: (cmd) => downlinksAPI.sendValve({ meter_id: id, command_type: cmd }),
    onSuccess: (res) => {
      const { success, command, error } = res.data;
      if (success) {
        toast.success(`${command.description} command sent successfully`);
      } else {
        toast.error(`Command queued (ChirpStack: ${error || 'unknown error'})`);
      }
      queryClient.invalidateQueries(['meter-detail', id]);
      setActiveCmd(null);
    },
    onError: (err) => {
      toast.error(err.response?.data?.error || 'Failed to send command');
      setActiveCmd(null);
    }
  });

  const handleCommand = (cmd) => {
    setActiveCmd(cmd);
    sendCommand.mutate(cmd);
  };

  const runLeakDetection = async () => {
    setAiLoading(true);
    try {
      const res = await aiAPI.leakDetection(id);
      setAiResult(res.data);
    } catch (err) {
      toast.error('AI analysis failed');
    } finally {
      setAiLoading(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-2 border-primary-500/30 border-t-primary-500 rounded-full animate-spin" />
      </div>
    );
  }

  if (!meter) return <div className="p-6 text-slate-400">Meter not found</div>;
  const { alarms, commands } = data;
  const canControl = user?.role === 'admin' || user?.role === 'operator';

  return (
    <div className="p-4 lg:p-6 space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Link href="/dashboard/meters" className="p-2 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors">
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-bold text-white font-display">{meter.meter_number}</h1>
            <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium border ${
              meter.is_online
                ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                : 'bg-red-500/10 text-red-400 border-red-500/20'
            }`}>
              <span className={`w-1.5 h-1.5 rounded-full ${meter.is_online ? 'bg-emerald-400 animate-pulse' : 'bg-red-400'}`} />
              {meter.is_online ? 'Online' : 'Offline'}
            </span>
          </div>
          <p className="text-slate-400 text-sm font-mono mt-0.5">{meter.device_eui}</p>
        </div>
        <button
          onClick={() => setSimulateLive(v => !v)}
          title="Simulated live telemetry is a display-only test overlay — it never writes to the backend"
          className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border transition-colors ${
            simulateLive
              ? 'bg-purple-500/10 text-purple-400 border-purple-500/30'
              : 'bg-slate-800/50 text-slate-500 border-slate-700'
          }`}
        >
          <FlaskConical className="w-3.5 h-3.5" />
          Simulated Live {simulateLive ? 'On' : 'Off'}
        </button>
        <button onClick={() => refetch()} className="btn-ghost text-xs">
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-slate-800">
        {TABS.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab.key
                ? 'border-primary-500 text-white'
                : 'border-transparent text-slate-500 hover:text-slate-300'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Key metrics — shown on every tab for at-a-glance context */}
      <div className="grid grid-cols-2 lg:grid-cols-6 gap-4">
        <StatCard icon={Droplets} label="Consumption" value={`${Number(meter.total_consumption || 0).toFixed(2)} m³`} color="text-primary-400" />
        <StatCard icon={Activity} label="Current Flow" value={`${Number(display.current_flow || 0).toFixed(2)} L/min`} color="text-emerald-400" />
        <StatCard icon={Gauge} label="Pressure" value={display.pressure ? `${Number(display.pressure).toFixed(1)} kPa` : '—'} color="text-amber-400" />
        <StatCard icon={Battery} label="Battery" value={display.battery_voltage ? `${Number(display.battery_voltage).toFixed(2)}V` : '—'} color={display.battery_voltage < 3.2 ? 'text-red-400' : 'text-emerald-400'} />
        <StatCard icon={Signal} label="RSSI" value={display.rssi ? `${Math.round(display.rssi)} dBm` : '—'} color="text-cyan-400" />
        <StatCard icon={Clock} label="Last Seen" value={meter.last_seen ? formatDistanceToNow(new Date(meter.last_seen), { addSuffix: true }) : 'Never'} color="text-slate-400" />
      </div>

      {activeTab === 'overview' && (
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
          <div className="xl:col-span-2 space-y-6">
            <div className="card-glow p-5">
              <h3 className="font-semibold text-white mb-4">Daily Consumption</h3>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={readingsData || []} margin={{ top: 5, right: 5, bottom: 0, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                  <XAxis dataKey="period" tick={{ fill: '#64748b', fontSize: 10 }} tickFormatter={d => d ? format(new Date(d), 'MM/dd HH:mm') : ''} />
                  <YAxis tick={{ fill: '#64748b', fontSize: 10 }} />
                  <Tooltip contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8 }} labelStyle={{ color: '#94a3b8' }} />
                  <Bar dataKey="consumption" fill="#42A5F5" radius={[3, 3, 0, 0]} name="Consumption (m³)" />
                </BarChart>
              </ResponsiveContainer>
            </div>

            <AiLeakDetectionCard aiResult={aiResult} aiLoading={aiLoading} runLeakDetection={runLeakDetection} setAiResult={setAiResult} />
          </div>

          <DeviceInfoCard meter={meter} />
        </div>
      )}

      {activeTab === 'readings' && (
        <div className="space-y-6">
          <div className="card-glow p-5">
            <h3 className="font-semibold text-white mb-4">Daily Consumption</h3>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={readingsData || []} margin={{ top: 5, right: 5, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                <XAxis dataKey="period" tick={{ fill: '#64748b', fontSize: 10 }} tickFormatter={d => d ? format(new Date(d), 'MM/dd HH:mm') : ''} />
                <YAxis tick={{ fill: '#64748b', fontSize: 10 }} />
                <Tooltip contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8 }} labelStyle={{ color: '#94a3b8' }} />
                <Bar dataKey="consumption" fill="#42A5F5" radius={[3, 3, 0, 0]} name="Consumption (m³)" />
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="card-glow p-5">
            <h3 className="font-semibold text-white mb-4">Pressure Trend</h3>
            <ResponsiveContainer width="100%" height={200}>
              <AreaChart data={readingsData || []} margin={{ top: 5, right: 5, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id="pressureGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#F59E0B" stopOpacity={0.4} />
                    <stop offset="100%" stopColor="#F59E0B" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                <XAxis dataKey="period" tick={{ fill: '#64748b', fontSize: 10 }} tickFormatter={d => d ? format(new Date(d), 'MM/dd HH:mm') : ''} />
                <YAxis tick={{ fill: '#64748b', fontSize: 10 }} unit=" kPa" />
                <Tooltip contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8 }} labelStyle={{ color: '#94a3b8' }} />
                <Area type="monotone" dataKey="pressure" stroke="#F59E0B" fill="url(#pressureGrad)" name="Pressure (kPa)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>

          <div className="card-glow p-5">
            <h3 className="font-semibold text-white mb-4">Battery Trend</h3>
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={readingsData || []} margin={{ top: 5, right: 5, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                <XAxis dataKey="period" tick={{ fill: '#64748b', fontSize: 10 }} tickFormatter={d => d ? format(new Date(d), 'MM/dd HH:mm') : ''} />
                <YAxis tick={{ fill: '#64748b', fontSize: 10 }} domain={[2.8, 4]} unit="V" />
                <Tooltip contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8 }} labelStyle={{ color: '#94a3b8' }} />
                <Line type="monotone" dataKey="battery_voltage" stroke="#10B981" dot={false} strokeWidth={2} name="Battery (V)" />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {activeTab === 'diagnostics' && (
        <div className="space-y-6">
          <div className="card-glow p-5">
            <div className="flex items-center gap-2 mb-4">
              <Radio className="w-4 h-4 text-cyan-400" />
              <h3 className="font-semibold text-white">Signal Quality (RSSI / SNR — last 72h)</h3>
            </div>
            {!signalData?.length ? (
              <div className="text-center py-6 text-slate-500 text-sm">No signal data yet</div>
            ) : (
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={signalData} margin={{ top: 5, right: 5, bottom: 0, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                  <XAxis dataKey="timestamp" tick={{ fill: '#64748b', fontSize: 10 }} tickFormatter={d => d ? format(new Date(d), 'MM/dd HH:mm') : ''} />
                  <YAxis tick={{ fill: '#64748b', fontSize: 10 }} />
                  <Tooltip contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8 }} labelStyle={{ color: '#94a3b8' }} labelFormatter={d => format(new Date(d), 'MMM d, HH:mm:ss')} />
                  <Line type="monotone" dataKey="rssi" stroke="#22d3ee" dot={false} strokeWidth={2} name="RSSI (dBm)" />
                  <Line type="monotone" dataKey="snr" stroke="#a78bfa" dot={false} strokeWidth={2} name="SNR (dB)" />
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>

          <div className="card-glow p-5">
            <div className="flex items-center gap-2 mb-4">
              <Inbox className="w-4 h-4 text-slate-400" />
              <h3 className="font-semibold text-white">Packet History</h3>
            </div>
            {!packetsData?.length ? (
              <div className="text-center py-6 text-slate-500 text-sm">No packets received yet</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="data-table text-xs">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Gateway</th>
                      <th>RSSI</th>
                      <th>SNR</th>
                      <th>fPort/fCnt</th>
                      <th>Trigger</th>
                      <th>Raw Payload (hex)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {packetsData.map((p, i) => (
                      <tr key={i}>
                        <td className="text-slate-400">{format(new Date(p.timestamp), 'MM/dd HH:mm:ss')}</td>
                        <td className="font-mono text-slate-500">{p.gateway_eui || '—'}</td>
                        <td className="text-cyan-400">{p.rssi ?? '—'}</td>
                        <td className="text-purple-300">{p.snr ?? '—'}</td>
                        <td className="text-slate-400">{p.f_port ?? '—'}/{p.f_cnt ?? '—'}</td>
                        <td className="text-slate-400">{p.trigger_source ?? '—'}</td>
                        <td className="font-mono text-slate-500 max-w-[200px] truncate" title={p.raw_payload}>
                          {p.raw_payload ? base64ToHex(p.raw_payload) || '—' : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {activeTab === 'alarms' && (
        <div className="card-glow p-5">
          <h3 className="font-semibold text-white mb-4">Alarm History</h3>
          {!alarms?.length ? (
            <div className="text-center py-6 text-slate-500">
              <CheckCircle className="w-8 h-8 mx-auto mb-2 opacity-30" />
              <p className="text-sm">No alarms recorded</p>
            </div>
          ) : (
            <div className="space-y-2">
              {alarms.map(alarm => (
                <div key={alarm.id} className="flex items-start gap-3 p-3 rounded-lg bg-slate-800/40">
                  <AlertTriangle className={`w-4 h-4 mt-0.5 flex-shrink-0 ${
                    alarm.severity === 'critical' ? 'text-red-400' :
                    alarm.severity === 'warning' ? 'text-amber-400' : 'text-blue-400'
                  }`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-white">
                        {ALARM_LABELS[alarm.alarm_type] || alarm.alarm_type}
                      </span>
                      <span className={`text-xs px-1.5 py-0.5 rounded font-medium capitalize ${
                        alarm.status === 'active' ? 'bg-red-500/10 text-red-400' :
                        alarm.status === 'acknowledged' ? 'bg-amber-500/10 text-amber-400' : 'bg-emerald-500/10 text-emerald-400'
                      }`}>{alarm.status}</span>
                    </div>
                    <p className="text-xs text-slate-500 mt-0.5">
                      {alarm.triggered_at ? format(new Date(alarm.triggered_at), 'MMM d, yyyy HH:mm') : ''}
                    </p>
                    {alarm.message && <p className="text-xs text-slate-500 mt-0.5">{alarm.message}</p>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === 'consumption' && (
        <div className="space-y-6">
          {/* Billing period summary */}
          {billingPeriodData && (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <StatCard icon={Droplets} label="This Month"
                value={`${billingPeriodData.consumption_m3?.toFixed(2) ?? '—'} m³`}
                color="text-primary-400" />
              <StatCard icon={Activity} label="Daily Average"
                value={`${billingPeriodData.daily_average_m3?.toFixed(3) ?? '—'} m³`}
                color="text-emerald-400" />
              <StatCard
                icon={billingPeriodData.change_percent > 0 ? TrendingUp : billingPeriodData.change_percent < 0 ? TrendingDown : Minus}
                label="vs Last Month"
                value={billingPeriodData.change_percent != null ? `${billingPeriodData.change_percent > 0 ? '+' : ''}${billingPeriodData.change_percent}%` : '—'}
                color={billingPeriodData.change_percent > 10 ? 'text-red-400' : billingPeriodData.change_percent < 0 ? 'text-emerald-400' : 'text-amber-400'}
              />
              <StatCard icon={Gauge} label="Projected Month"
                value={`${billingPeriodData.projected_month_total_m3?.toFixed(2) ?? '—'} m³`}
                color="text-cyan-400" />
            </div>
          )}

          {/* Period selector */}
          <div className="card-glow p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold text-white">Consumption History</h3>
              <div className="flex gap-1">
                {['daily', 'weekly', 'monthly', 'yearly'].map(p => (
                  <button
                    key={p}
                    onClick={() => setConsumptionPeriod(p)}
                    className={`px-3 py-1 text-xs rounded font-medium transition-colors capitalize ${
                      consumptionPeriod === p
                        ? 'bg-primary-600 text-white'
                        : 'bg-slate-800 text-slate-400 hover:text-slate-200'
                    }`}
                  >{p}</button>
                ))}
              </div>
            </div>

            {!consumptionData?.data?.length ? (
              <div className="text-center py-12 text-slate-500 text-sm">
                No consumption data for this period.<br />
                <span className="text-xs">Data is aggregated nightly; check back after the meter has been active for at least one full day.</span>
              </div>
            ) : (
              <>
                <ResponsiveContainer width="100%" height={240}>
                  <BarChart data={consumptionData.data} margin={{ top: 5, right: 5, bottom: 0, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                    <XAxis dataKey="period" tick={{ fill: '#64748b', fontSize: 10 }} />
                    <YAxis tick={{ fill: '#64748b', fontSize: 10 }} unit=" m³" />
                    <Tooltip
                      contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8 }}
                      formatter={(v) => [`${parseFloat(v).toFixed(3)} m³`, 'Consumption']}
                    />
                    <Bar dataKey="consumption_m3" fill="#42A5F5" radius={[3, 3, 0, 0]} name="Consumption (m³)" />
                  </BarChart>
                </ResponsiveContainer>

                {/* Summary stats */}
                <div className="mt-4 grid grid-cols-3 gap-4 pt-4 border-t border-slate-800">
                  <div className="text-center">
                    <p className="text-xs text-slate-500">Total</p>
                    <p className="text-lg font-bold text-white font-mono">{consumptionData.total_consumption_m3?.toFixed(2)} m³</p>
                  </div>
                  <div className="text-center">
                    <p className="text-xs text-slate-500">Avg / Period</p>
                    <p className="text-lg font-bold text-emerald-400 font-mono">{consumptionData.average_per_period_m3?.toFixed(3)} m³</p>
                  </div>
                  <div className="text-center">
                    <p className="text-xs text-slate-500">Trend</p>
                    <p className={`text-sm font-semibold capitalize ${
                      consumptionData.trend === 'increasing' ? 'text-red-400' :
                      consumptionData.trend === 'decreasing' ? 'text-emerald-400' : 'text-slate-400'
                    }`}>{consumptionData.trend?.replace('_', ' ') ?? '—'}</p>
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Device health */}
          {healthData && (
            <div className="card-glow p-5">
              <div className="flex items-center gap-2 mb-4">
                <Zap className="w-4 h-4 text-amber-400" />
                <h3 className="font-semibold text-white">Device Health</h3>
                <span className={`ml-auto text-2xl font-bold font-mono ${
                  healthData.overall_score >= 85 ? 'text-emerald-400' :
                  healthData.overall_score >= 70 ? 'text-primary-400' :
                  healthData.overall_score >= 50 ? 'text-amber-400' : 'text-red-400'
                }`}>{healthData.overall_score}</span>
                <span className={`text-xs capitalize px-2 py-0.5 rounded border ${
                  healthData.grade === 'excellent' ? 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20' :
                  healthData.grade === 'good' ? 'text-primary-400 bg-primary-500/10 border-primary-500/20' :
                  healthData.grade === 'fair' ? 'text-amber-400 bg-amber-500/10 border-amber-500/20' :
                  'text-red-400 bg-red-500/10 border-red-500/20'
                }`}>{healthData.grade}</span>
              </div>
              <div className="space-y-3">
                {Object.entries(healthData.components).map(([key, comp]) => (
                  <div key={key}>
                    <div className="flex justify-between text-xs mb-1">
                      <span className="text-slate-400 capitalize">{key}</span>
                      <span className="text-slate-300">{comp.score != null ? comp.score : '—'}</span>
                    </div>
                    <div className="h-1.5 bg-slate-800 rounded-full">
                      <div
                        className={`h-full rounded-full transition-all ${
                          (comp.score ?? 0) >= 70 ? 'bg-emerald-500' :
                          (comp.score ?? 0) >= 50 ? 'bg-amber-500' : 'bg-red-500'
                        }`}
                        style={{ width: `${comp.score ?? 0}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {activeTab === 'leaks' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-white font-semibold">Leak Events</h3>
              <p className="text-xs text-slate-500 mt-0.5">Server-side anomaly detection across 6 algorithms</p>
            </div>
            <button
              onClick={() => triggerLeakDetection.mutate()}
              disabled={triggerLeakDetection.isPending}
              className="btn-primary text-sm flex items-center gap-2"
            >
              {triggerLeakDetection.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldAlert className="w-4 h-4" />}
              Scan Now
            </button>
          </div>

          {!leaksData?.data?.length ? (
            <div className="card-glow p-10 text-center">
              <CheckCircle className="w-10 h-10 mx-auto mb-3 text-emerald-400/40" />
              <p className="text-slate-400 font-medium">No leak events detected</p>
              <p className="text-xs text-slate-600 mt-1">Scans run hourly automatically. Click "Scan Now" to run immediately.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {leaksData.data.map(leak => (
                <div key={leak.id} className={`card-glow p-4 border-l-4 ${
                  leak.severity === 'critical' ? 'border-l-red-500' :
                  leak.severity === 'high' ? 'border-l-orange-500' :
                  leak.severity === 'medium' ? 'border-l-amber-500' : 'border-l-blue-500'
                }`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-semibold text-white">
                          {LEAK_TYPE_LABELS[leak.detection_type] || leak.detection_type}
                        </span>
                        <span className={`text-xs px-2 py-0.5 rounded-full border capitalize ${SEVERITY_COLORS[leak.severity]}`}>
                          {leak.severity}
                        </span>
                        <span className={`text-xs px-2 py-0.5 rounded-full border capitalize ${
                          leak.status === 'active' ? 'text-red-400 bg-red-500/10 border-red-500/20' :
                          leak.status === 'resolved' ? 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20' :
                          'text-slate-400 bg-slate-700/50 border-slate-600'
                        }`}>{leak.status}</span>
                        <span className="text-xs text-slate-500 ml-auto">
                          AI: {(parseFloat(leak.ai_score) * 100).toFixed(0)}%
                        </span>
                      </div>
                      <p className="text-xs text-slate-400 mt-1 leading-relaxed">{leak.ai_analysis}</p>
                      {leak.evidence && (
                        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                          {Object.entries(leak.evidence).filter(([k]) => !['window_start','window_end','date'].includes(k)).map(([k, v]) => (
                            <span key={k} className="text-xs text-slate-500">
                              <span className="text-slate-600">{k.replace(/_/g, ' ')}:</span> {typeof v === 'number' ? v.toFixed ? v.toFixed(2) : v : v}
                            </span>
                          ))}
                        </div>
                      )}
                      <p className="text-xs text-slate-600 mt-2">
                        Detected {leak.detected_at ? format(new Date(leak.detected_at), 'MMM d, yyyy HH:mm') : '—'}
                        {leak.resolved_by_name && ` · Resolved by ${leak.resolved_by_name}`}
                      </p>
                    </div>

                    {leak.status === 'active' && canControl && (
                      <div className="flex flex-col gap-1.5 flex-shrink-0">
                        <button
                          onClick={() => resolveLeakMutation.mutate({ leakId: leak.id, status: 'resolved' })}
                          disabled={resolveLeakMutation.isPending}
                          className="text-xs px-2 py-1 rounded bg-emerald-600/20 text-emerald-400 hover:bg-emerald-600/30 border border-emerald-600/30 transition-colors"
                        >
                          Resolve
                        </button>
                        <button
                          onClick={() => resolveLeakMutation.mutate({ leakId: leak.id, status: 'false_positive' })}
                          disabled={resolveLeakMutation.isPending}
                          className="text-xs px-2 py-1 rounded bg-slate-700/50 text-slate-400 hover:bg-slate-700 border border-slate-600 transition-colors"
                        >
                          False +
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === 'valve' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="card-glow p-5">
            <h3 className="font-semibold text-white mb-2">Valve Control</h3>
            <p className="text-xs text-slate-500 mb-4">Send downlink commands via ChirpStack</p>

            {!canControl ? (
              <div className="p-3 bg-slate-800/50 rounded-lg border border-slate-700 text-xs text-slate-400 flex items-center gap-2">
                <Info className="w-4 h-4 flex-shrink-0" />
                Viewer role cannot send commands
              </div>
            ) : (
              <div className="space-y-2">
                <ValveButton label="Open Valve" icon={Unlock} variant="open" loading={activeCmd === 'open_valve'} disabled={!!activeCmd} onClick={() => handleCommand('open_valve')} />
                <ValveButton label="Close Valve" icon={Lock} variant="close" loading={activeCmd === 'close_valve'} disabled={!!activeCmd} onClick={() => handleCommand('close_valve')} />
                <ValveButton label="Dredge Valve" icon={RotateCcw} variant="dredge" loading={activeCmd === 'dredge_valve'} disabled={!!activeCmd} onClick={() => handleCommand('dredge_valve')} />
              </div>
            )}

            <div className="mt-4 p-3 bg-slate-900/80 rounded-lg border border-slate-800">
              <p className="text-xs text-slate-500 font-medium mb-2">Command Reference</p>
              {[
                { label: 'Open Valve', hex: '261F0045' },
                { label: 'Close Valve', hex: '261F0146' },
                { label: 'Dredge Valve', hex: '261F0247' }
              ].map(cmd => (
                <div key={cmd.label} className="flex justify-between text-xs mb-1.5 last:mb-0">
                  <span className="text-slate-500">{cmd.label}</span>
                  <span className="font-mono text-slate-400">{cmd.hex}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="card-glow p-5">
            <h3 className="font-semibold text-white mb-4">Recent Commands</h3>
            {!commands?.length ? (
              <p className="text-xs text-slate-500">No commands sent</p>
            ) : (
              <div className="space-y-2">
                {commands.map(cmd => (
                  <div key={cmd.id} className="flex items-center justify-between text-xs">
                    <div>
                      <span className="text-slate-300 capitalize">{cmd.command_type.replace(/_/g, ' ')}</span>
                      <p className="text-slate-600">{cmd.sent_by_name}</p>
                    </div>
                    <div className="text-right">
                      <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${
                        cmd.status === 'confirmed' ? 'text-emerald-400 bg-emerald-500/10' :
                        cmd.status === 'failed' ? 'text-red-400 bg-red-500/10' :
                        'text-amber-400 bg-amber-500/10'
                      }`}>{cmd.status}</span>
                      <p className="text-slate-600 mt-0.5">{cmd.created_at ? format(new Date(cmd.created_at), 'MM/dd HH:mm') : ''}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {activeTab === 'valve' && canControl && (
        <DeviceConfigCard meterId={id} queryClient={queryClient} />
      )}
    </div>
  );
}

function DeviceConfigCard({ meterId, queryClient }) {
  const [field, setField] = useState('report_interval');
  const [value, setValue] = useState('');

  const { data: fields } = useQuery({
    queryKey: ['config-fields'],
    queryFn: () => downlinksAPI.getConfigFields().then(r => r.data),
    staleTime: Infinity
  });

  const sendConfig = useMutation({
    mutationFn: () => downlinksAPI.sendConfig({ meter_id: meterId, field, value }),
    onSuccess: (res) => {
      const { success, error } = res.data;
      if (success) toast.success('Configuration command sent — confirms on the device\'s next uplink');
      else toast.error(`Command queued (ChirpStack: ${error || 'unknown error'})`);
      queryClient.invalidateQueries(['meter-detail', meterId]);
      setValue('');
    },
    onError: (err) => toast.error(err.response?.data?.error || 'Failed to send config command')
  });

  const selected = fields?.find(f => f.field === field);

  return (
    <div className="card-glow p-5">
      <h3 className="font-semibold text-white mb-2">Remote Configuration (OTA)</h3>
      <p className="text-xs text-slate-500 mb-4">
        Writes a protocol config field over LoRaWAN downlink. There is no separate
        acknowledgement — the change is confirmed when the device's next uplink reflects it.
      </p>
      <div className="flex flex-col sm:flex-row gap-3">
        <select className="select" value={field} onChange={e => setField(e.target.value)}>
          {(fields || []).map(f => <option key={f.field} value={f.field}>{f.description}</option>)}
        </select>
        <input
          className="input flex-1"
          placeholder={selected ? `Value (${selected.unit})` : 'Value'}
          value={value}
          onChange={e => setValue(e.target.value)}
        />
        <button
          className="btn-primary text-sm whitespace-nowrap"
          disabled={!value || sendConfig.isPending}
          onClick={() => sendConfig.mutate()}
        >
          {sendConfig.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Send'}
        </button>
      </div>
    </div>
  );
}

function DeviceInfoCard({ meter }) {
  return (
    <div className="card-glow p-5">
      <h3 className="font-semibold text-white mb-4">Device Information</h3>
      <div className="space-y-3">
        {[
          { label: 'Device EUI', value: meter.device_eui, mono: true },
          { label: 'Meter Number', value: meter.meter_number },
          { label: 'Customer', value: meter.customer_name || '—' },
          { label: 'Phone', value: meter.customer_phone || '—' },
          { label: 'Status', value: meter.status },
          { label: 'Valve Status', value: meter.valve_status },
          { label: 'Last Seen', value: meter.last_seen ? formatDistanceToNow(new Date(meter.last_seen), { addSuffix: true }) : 'Never' },
          { label: 'Installed', value: meter.installed_at ? format(new Date(meter.installed_at), 'MMM d, yyyy') : '—' },
          { label: 'Firmware', value: meter.firmware_version || '—' },
          { label: 'Address', value: meter.installation_address || '—' }
        ].map(({ label, value, mono }) => (
          <div key={label} className="flex justify-between gap-3">
            <span className="text-xs text-slate-500">{label}</span>
            <span className={`text-xs text-right ${mono ? 'font-mono text-primary-400' : 'text-slate-300'}`}>{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function AiLeakDetectionCard({ aiResult, aiLoading, runLeakDetection, setAiResult }) {
  return (
    <div className="card-glow p-5">
      <div className="flex items-center gap-2 mb-3">
        <Brain className="w-4 h-4 text-purple-400" />
        <h3 className="font-semibold text-white">AI Leak Detection</h3>
      </div>

      {!aiResult ? (
        <button
          onClick={runLeakDetection}
          disabled={aiLoading}
          className="w-full py-2 px-4 bg-purple-600/20 hover:bg-purple-600/30 border border-purple-500/30 rounded-lg text-purple-400 text-sm font-medium transition-colors flex items-center justify-center gap-2 disabled:opacity-60"
        >
          {aiLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Brain className="w-4 h-4" />}
          {aiLoading ? 'Analyzing...' : 'Run Analysis'}
        </button>
      ) : (
        <div className="space-y-3">
          <div className={`flex items-center gap-2 px-3 py-2 rounded-lg border ${
            aiResult.riskLevel === 'high' ? 'bg-red-500/10 border-red-500/20 text-red-400' :
            aiResult.riskLevel === 'medium' ? 'bg-amber-500/10 border-amber-500/20 text-amber-400' :
            'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
          }`}>
            <AlertTriangle className="w-4 h-4 flex-shrink-0" />
            <span className="text-sm font-medium capitalize">{aiResult.riskLevel} Risk</span>
          </div>
          {aiResult.analysis && <p className="text-xs text-slate-400 leading-relaxed">{aiResult.analysis}</p>}
          <button onClick={() => setAiResult(null)} className="text-xs text-slate-500 hover:text-slate-300 transition-colors">
            Clear & run again
          </button>
        </div>
      )}
    </div>
  );
}
