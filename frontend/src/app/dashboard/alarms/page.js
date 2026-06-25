'use client';
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { alarmsAPI, aiAPI } from '../../../lib/api';
import { AlertTriangle, CheckCircle, Eye, Brain, Filter, RefreshCw, Loader2 } from 'lucide-react';
import { format, formatDistanceToNow } from 'date-fns';
import toast from 'react-hot-toast';
import { useAuthStore } from '../../../store/authStore';

const ALARM_LABELS = {
  low_battery: 'Low Battery', valve_failure: 'Valve Failure',
  magnetic_attack: 'Magnetic Attack', water_leakage: 'Water Leakage',
  reverse_flow: 'Reverse Flow', pipe_burst: 'Pipe Burst', communication_loss: 'Comm. Loss'
};

const SEVERITY_CLS = {
  critical: 'text-red-400 bg-red-500/10 border-red-500/20',
  warning:  'text-amber-400 bg-amber-500/10 border-amber-500/20',
  info:     'text-blue-400 bg-blue-500/10 border-blue-500/20',
};

const STATUS_CLS = {
  active:       'text-red-400 bg-red-500/10',
  acknowledged: 'text-amber-400 bg-amber-500/10',
  resolved:     'text-emerald-400 bg-emerald-500/10',
};

export default function AlarmsPage() {
  const [statusFilter, setStatusFilter] = useState('active');
  const [typeFilter, setTypeFilter] = useState('');
  const [severityFilter, setSeverityFilter] = useState('');
  const [aiAlarmId, setAiAlarmId] = useState(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiResults, setAiResults] = useState({});
  const { user } = useAuthStore();
  const queryClient = useQueryClient();

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['alarms', statusFilter, typeFilter, severityFilter],
    queryFn: () => alarmsAPI.list({
      status: statusFilter || undefined,
      alarm_type: typeFilter || undefined,
      severity: severityFilter || undefined,
      limit: 100
    }).then(r => r.data),
    refetchInterval: 30000
  });

  const ackMutation = useMutation({
    mutationFn: (id) => alarmsAPI.acknowledge(id),
    onSuccess: () => { toast.success('Alarm acknowledged'); queryClient.invalidateQueries(['alarms']); },
    onError: () => toast.error('Failed to acknowledge')
  });

  const resolveMutation = useMutation({
    mutationFn: (id) => alarmsAPI.resolve(id, {}),
    onSuccess: () => { toast.success('Alarm resolved'); queryClient.invalidateQueries(['alarms']); },
    onError: () => toast.error('Failed to resolve')
  });

  const analyzeAlarm = async (alarmId) => {
    setAiAlarmId(alarmId);
    setAiLoading(true);
    try {
      const res = await aiAPI.analyzeAlarm(alarmId);
      setAiResults(prev => ({ ...prev, [alarmId]: res.data }));
    } catch {
      toast.error('AI analysis failed');
    } finally {
      setAiLoading(false);
    }
  };

  const alarms = data?.data || [];
  const canAct = user?.role === 'admin' || user?.role === 'operator';

  return (
    <div className="p-4 lg:p-6 space-y-5 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white font-display">Alarms</h1>
          <p className="text-slate-400 text-sm mt-0.5">{alarms.length} alarms</p>
        </div>
        <button onClick={() => refetch()} className="btn-ghost text-xs">
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <select className="select w-auto" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          <option value="">All Statuses</option>
          <option value="active">Active</option>
          <option value="acknowledged">Acknowledged</option>
          <option value="resolved">Resolved</option>
        </select>
        <select className="select w-auto" value={severityFilter} onChange={e => setSeverityFilter(e.target.value)}>
          <option value="">All Severities</option>
          <option value="critical">Critical</option>
          <option value="warning">Warning</option>
          <option value="info">Info</option>
        </select>
        <select className="select w-auto" value={typeFilter} onChange={e => setTypeFilter(e.target.value)}>
          <option value="">All Types</option>
          {Object.entries(ALARM_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>

      {/* Alarms list */}
      <div className="card-glow overflow-hidden">
        {isLoading ? (
          <div className="flex items-center justify-center p-12">
            <Loader2 className="w-6 h-6 text-primary-400 animate-spin" />
          </div>
        ) : alarms.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-slate-500">
            <CheckCircle className="w-12 h-12 mb-3 opacity-30" />
            <p className="font-medium">No alarms found</p>
            <p className="text-sm mt-1">All systems operating normally</p>
          </div>
        ) : (
          <div className="divide-y divide-slate-800">
            {alarms.map(alarm => (
              <div key={alarm.id} className="p-4 hover:bg-slate-800/20 transition-colors">
                <div className="flex items-start gap-4">
                  <div className={`p-2 rounded-lg border flex-shrink-0 ${SEVERITY_CLS[alarm.severity]}`}>
                    <AlertTriangle className="w-4 h-4" />
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium text-white text-sm">
                            {ALARM_LABELS[alarm.alarm_type] || alarm.alarm_type}
                          </span>
                          <span className={`text-xs px-2 py-0.5 rounded-full border ${SEVERITY_CLS[alarm.severity]}`}>
                            {alarm.severity}
                          </span>
                          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_CLS[alarm.status]}`}>
                            {alarm.status}
                          </span>
                        </div>
                        <div className="flex items-center gap-3 mt-1 text-xs text-slate-500">
                          <span>Meter: <span className="text-slate-300">{alarm.meter_number || '—'}</span></span>
                          {alarm.customer_name && <span>· {alarm.customer_name}</span>}
                          <span>· EUI: <span className="font-mono text-slate-400">{alarm.device_eui}</span></span>
                        </div>
                        {alarm.message && (
                          <p className="text-xs text-slate-500 mt-1.5">{alarm.message}</p>
                        )}
                        <p className="text-xs text-slate-600 mt-1">
                          {alarm.triggered_at ? `Triggered ${formatDistanceToNow(new Date(alarm.triggered_at), { addSuffix: true })}` : ''}
                          {alarm.acknowledged_at ? ` · Acknowledged by ${alarm.acknowledged_by_name}` : ''}
                        </p>

                        {/* AI result */}
                        {aiResults[alarm.id] && (
                          <div className="mt-3 p-3 bg-purple-500/5 border border-purple-500/20 rounded-lg">
                            <div className="flex items-center gap-1.5 mb-1.5">
                              <Brain className="w-3 h-3 text-purple-400" />
                              <span className="text-xs text-purple-400 font-medium">AI Analysis</span>
                            </div>
                            <p className="text-xs text-slate-400">{aiResults[alarm.id].analysis}</p>
                            {aiResults[alarm.id].recommendation && (
                              <p className="text-xs text-slate-300 mt-1 font-medium">{aiResults[alarm.id].recommendation}</p>
                            )}
                          </div>
                        )}
                      </div>

                      {/* Actions */}
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <button
                          onClick={() => analyzeAlarm(alarm.id)}
                          disabled={aiLoading && aiAlarmId === alarm.id}
                          className="p-1.5 text-purple-400 hover:bg-purple-500/10 rounded-lg transition-colors text-xs"
                          title="AI Analyze"
                        >
                          {aiLoading && aiAlarmId === alarm.id
                            ? <Loader2 className="w-4 h-4 animate-spin" />
                            : <Brain className="w-4 h-4" />}
                        </button>

                        {canAct && alarm.status === 'active' && (
                          <button
                            onClick={() => ackMutation.mutate(alarm.id)}
                            disabled={ackMutation.isPending}
                            className="btn-secondary text-xs py-1 px-2"
                          >
                            <Eye className="w-3 h-3" />
                            Ack
                          </button>
                        )}
                        {canAct && alarm.status !== 'resolved' && (
                          <button
                            onClick={() => resolveMutation.mutate(alarm.id)}
                            disabled={resolveMutation.isPending}
                            className="text-xs px-2 py-1 bg-emerald-600/20 hover:bg-emerald-600/30 border border-emerald-500/30 rounded-lg text-emerald-400 transition-colors flex items-center gap-1"
                          >
                            <CheckCircle className="w-3 h-3" />
                            Resolve
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
