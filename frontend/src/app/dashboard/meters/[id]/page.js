'use client';
import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { metersAPI, downlinksAPI, aiAPI } from '../../../../lib/api';
import {
  ArrowLeft, Droplets, Battery, Signal, Clock, Gauge,
  Zap, AlertTriangle, CheckCircle, XCircle, RefreshCw,
  TrendingUp, Activity, Brain, Lock, Unlock, RotateCcw,
  Loader2, Info
} from 'lucide-react';
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip, ResponsiveContainer
} from 'recharts';
import { format, formatDistanceToNow } from 'date-fns';
import { useQuery as useRQQuery } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import Link from 'next/link';
import { useAuthStore } from '../../../../store/authStore';

const ALARM_LABELS = {
  low_battery: 'Low Battery', valve_failure: 'Valve Failure',
  magnetic_attack: 'Magnetic Attack', water_leakage: 'Water Leakage',
  reverse_flow: 'Reverse Flow', pipe_burst: 'Pipe Burst', communication_loss: 'Communication Loss'
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

export default function MeterDetailPage() {
  const { id } = useParams();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user } = useAuthStore();
  const [activeCmd, setActiveCmd] = useState(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiResult, setAiResult] = useState(null);

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

  const { meter, readings, alarms, commands } = data || {};
  if (!meter) return <div className="p-6 text-slate-400">Meter not found</div>;

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
        <button onClick={() => refetch()} className="btn-ghost text-xs">
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* Left column */}
        <div className="xl:col-span-2 space-y-6">
          {/* Key metrics */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[
              { icon: Droplets, label: 'Total Consumption', value: `${Number(meter.total_consumption || 0).toFixed(2)} m³`, color: 'text-primary-400' },
              { icon: Activity, label: 'Current Flow', value: `${Number(meter.current_flow || 0).toFixed(2)} L/min`, color: 'text-emerald-400' },
              { icon: Battery, label: 'Battery', value: meter.battery_voltage ? `${meter.battery_voltage}V` : '—', color: meter.battery_voltage < 3.2 ? 'text-red-400' : 'text-emerald-400' },
              { icon: Signal, label: 'RSSI', value: meter.rssi ? `${meter.rssi} dBm` : '—', color: 'text-cyan-400' },
            ].map((stat, i) => (
              <div key={i} className="card-glow p-4">
                <div className="flex items-center gap-2 mb-2">
                  <stat.icon className={`w-4 h-4 ${stat.color}`} />
                  <span className="text-xs text-slate-500">{stat.label}</span>
                </div>
                <p className={`text-xl font-bold font-mono ${stat.color}`}>{stat.value}</p>
              </div>
            ))}
          </div>

          {/* Consumption Chart */}
          <div className="card-glow p-5">
            <h3 className="font-semibold text-white mb-4">7-Day Consumption History</h3>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={readingsData || []} margin={{ top: 5, right: 5, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                <XAxis dataKey="period" tick={{ fill: '#64748b', fontSize: 10 }}
                  tickFormatter={d => d ? format(new Date(d), 'MM/dd HH:mm') : ''} />
                <YAxis tick={{ fill: '#64748b', fontSize: 10 }} />
                <Tooltip
                  contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8 }}
                  labelStyle={{ color: '#94a3b8' }}
                />
                <Bar dataKey="consumption" fill="#42A5F5" radius={[3, 3, 0, 0]} name="Consumption (m³)" />
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Alarm History */}
          <div className="card-glow p-5">
            <h3 className="font-semibold text-white mb-4">Alarm History</h3>
            {!alarms?.length ? (
              <div className="text-center py-6 text-slate-500">
                <CheckCircle className="w-8 h-8 mx-auto mb-2 opacity-30" />
                <p className="text-sm">No alarms recorded</p>
              </div>
            ) : (
              <div className="space-y-2">
                {alarms.slice(0, 10).map(alarm => (
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
        </div>

        {/* Right column */}
        <div className="space-y-6">
          {/* Device Info */}
          <div className="card-glow p-5">
            <h3 className="font-semibold text-white mb-4">Device Information</h3>
            <div className="space-y-3">
              {[
                { label: 'Device EUI', value: meter.device_eui, mono: true },
                { label: 'Meter Number', value: meter.meter_number },
                { label: 'Customer', value: meter.customer_name || '—' },
                { label: 'Phone', value: meter.customer_phone || '—' },
                { label: 'Valve Status', value: meter.valve_status },
                { label: 'Last Seen', value: meter.last_seen ? formatDistanceToNow(new Date(meter.last_seen), { addSuffix: true }) : 'Never' },
                { label: 'Installed', value: meter.installed_at ? format(new Date(meter.installed_at), 'MMM d, yyyy') : '—' },
                { label: 'Firmware', value: meter.firmware_version || '—' },
                { label: 'Address', value: meter.installation_address || '—' },
              ].map(({ label, value, mono }) => (
                <div key={label} className="flex justify-between gap-3">
                  <span className="text-xs text-slate-500">{label}</span>
                  <span className={`text-xs text-right ${mono ? 'font-mono text-primary-400' : 'text-slate-300'}`}>{value}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Valve Control */}
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
                <ValveButton
                  label="Open Valve"
                  icon={Unlock}
                  variant="open"
                  loading={activeCmd === 'open_valve'}
                  disabled={!!activeCmd}
                  onClick={() => handleCommand('open_valve')}
                />
                <ValveButton
                  label="Close Valve"
                  icon={Lock}
                  variant="close"
                  loading={activeCmd === 'close_valve'}
                  disabled={!!activeCmd}
                  onClick={() => handleCommand('close_valve')}
                />
                <ValveButton
                  label="Dredge Valve"
                  icon={RotateCcw}
                  variant="dredge"
                  loading={activeCmd === 'dredge_valve'}
                  disabled={!!activeCmd}
                  onClick={() => handleCommand('dredge_valve')}
                />
              </div>
            )}

            {/* Command reference */}
            <div className="mt-4 p-3 bg-slate-900/80 rounded-lg border border-slate-800">
              <p className="text-xs text-slate-500 font-medium mb-2">Command Reference</p>
              {[
                { label: 'Open Valve', hex: '261F0045', b64: Buffer.from('261F0045', 'hex').toString('base64') },
                { label: 'Close Valve', hex: '261F0146', b64: 'Jh8BRg==' },
                { label: 'Dredge Valve', hex: '261F0247', b64: 'Jh8CRw==' },
              ].map(cmd => (
                <div key={cmd.label} className="flex justify-between text-xs mb-1.5 last:mb-0">
                  <span className="text-slate-500">{cmd.label}</span>
                  <span className="font-mono text-slate-400">{cmd.hex}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Recent Commands */}
          <div className="card-glow p-5">
            <h3 className="font-semibold text-white mb-4">Recent Commands</h3>
            {!commands?.length ? (
              <p className="text-xs text-slate-500">No commands sent</p>
            ) : (
              <div className="space-y-2">
                {commands.slice(0, 5).map(cmd => (
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

          {/* AI Leak Detection */}
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
                {aiResult.analysis && (
                  <p className="text-xs text-slate-400 leading-relaxed">{aiResult.analysis}</p>
                )}
                <button
                  onClick={() => setAiResult(null)}
                  className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
                >
                  Clear & run again
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
