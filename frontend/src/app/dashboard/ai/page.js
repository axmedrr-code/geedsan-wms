'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { aiAPI, metersAPI } from '../../../lib/api';
import { Brain, TrendingUp, AlertTriangle, Droplets, Loader2, Search, Zap } from 'lucide-react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import toast from 'react-hot-toast';

export default function AIPage() {
  const [selectedMeter, setSelectedMeter] = useState('');
  const [leakResult, setLeakResult] = useState(null);
  const [forecastResult, setForecastResult] = useState(null);
  const [loading, setLoading] = useState({ leak: false, forecast: false });

  const { data: metersData } = useQuery({
    queryKey: ['meters-list-ai'],
    queryFn: () => metersAPI.list({ limit: 200 }).then(r => r.data)
  });

  const { data: anomalies, isLoading: anomaliesLoading, refetch: refetchAnomalies } = useQuery({
    queryKey: ['anomalies'],
    queryFn: () => aiAPI.getAnomalies().then(r => r.data)
  });

  const meters = metersData?.data || [];

  const runLeak = async () => {
    if (!selectedMeter) return toast.error('Select a meter first');
    setLoading(l => ({ ...l, leak: true }));
    try {
      const res = await aiAPI.leakDetection(selectedMeter);
      setLeakResult(res.data);
    } catch (err) {
      toast.error('Leak detection failed: ' + (err.response?.data?.error || err.message));
    } finally {
      setLoading(l => ({ ...l, leak: false }));
    }
  };

  const runForecast = async () => {
    if (!selectedMeter) return toast.error('Select a meter first');
    setLoading(l => ({ ...l, forecast: true }));
    try {
      const res = await aiAPI.forecast(selectedMeter, 7);
      setForecastResult(res.data);
    } catch (err) {
      toast.error('Forecast failed');
    } finally {
      setLoading(l => ({ ...l, forecast: false }));
    }
  };

  const RISK_COLORS = { low: 'emerald', medium: 'amber', high: 'red' };
  const rc = leakResult ? RISK_COLORS[leakResult.riskLevel] || 'slate' : null;

  const chartData = forecastResult ? [
    ...(forecastResult.historicalData || []).slice(-14).map(d => ({
      date: d.date, actual: parseFloat(d.daily_consumption || 0).toFixed(4), predicted: null
    })),
    ...(forecastResult.forecast || []).map(d => ({
      date: d.date, actual: null,
      predicted: parseFloat(d.predicted), lower: parseFloat(d.lower), upper: parseFloat(d.upper)
    }))
  ] : [];

  return (
    <div className="p-4 lg:p-6 space-y-6 animate-fade-in">
      <div className="flex items-center gap-3">
        <div className="p-2 rounded-xl bg-purple-500/10 border border-purple-500/20">
          <Brain className="w-5 h-5 text-purple-400" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-white font-display">AI Analytics</h1>
          <p className="text-slate-400 text-sm mt-0.5">Machine learning powered water management insights</p>
        </div>
      </div>

      {/* Meter selector */}
      <div className="card-glow p-4">
        <label className="block text-sm font-medium text-slate-400 mb-2">Select Meter for Analysis</label>
        <select
          className="select max-w-md"
          value={selectedMeter}
          onChange={e => { setSelectedMeter(e.target.value); setLeakResult(null); setForecastResult(null); }}
        >
          <option value="">-- Choose a meter --</option>
          {meters.map(m => (
            <option key={m.id} value={m.id}>
              {m.meter_number} {m.customer_name ? `· ${m.customer_name}` : ''} ({m.device_eui})
            </option>
          ))}
        </select>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {/* Leak Detection */}
        <div className="card-glow p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Droplets className="w-5 h-5 text-blue-400" />
              <h3 className="font-semibold text-white">Leak Detection</h3>
            </div>
            <button
              onClick={runLeak}
              disabled={!selectedMeter || loading.leak}
              className="btn-primary text-xs py-1.5 px-3"
            >
              {loading.leak ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
              Analyze
            </button>
          </div>
          <p className="text-xs text-slate-500">Detects continuous night-time flow and anomalous consumption patterns that may indicate leaks.</p>

          {leakResult && (
            <div className="space-y-3 animate-fade-in">
              <div className={`flex items-center gap-3 p-4 rounded-xl border bg-${rc}-500/5 border-${rc}-500/20`}>
                <div className={`w-12 h-12 rounded-full flex items-center justify-center text-lg font-bold
                  bg-${rc}-500/10 text-${rc}-400`}>
                  {leakResult.riskLevel === 'low' ? '✓' : leakResult.riskLevel === 'medium' ? '!' : '!!'}
                </div>
                <div>
                  <p className={`font-bold text-${rc}-400 capitalize`}>{leakResult.riskLevel} Risk</p>
                  <p className="text-xs text-slate-400">Meter: {leakResult.meterNumber}</p>
                </div>
              </div>

              {leakResult.indicators.length > 0 && (
                <div>
                  <p className="text-xs text-slate-500 font-medium mb-2">Detected Indicators</p>
                  {leakResult.indicators.map((ind, i) => (
                    <div key={i} className="flex items-start gap-2 text-xs text-slate-400 mb-1">
                      <AlertTriangle className="w-3 h-3 text-amber-400 mt-0.5 flex-shrink-0" />
                      {ind}
                    </div>
                  ))}
                </div>
              )}

              {leakResult.analysis && (
                <div className="p-3 bg-slate-800/50 rounded-lg border border-slate-700/50">
                  <p className="text-xs text-slate-500 font-medium mb-1">AI Analysis</p>
                  <p className="text-xs text-slate-300 leading-relaxed">{leakResult.analysis}</p>
                </div>
              )}

              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="p-2 bg-slate-800/50 rounded-lg">
                  <p className="text-slate-500">Night Flow Events</p>
                  <p className="text-white font-medium">{leakResult.nightFlowCount}</p>
                </div>
                <div className="p-2 bg-slate-800/50 rounded-lg">
                  <p className="text-slate-500">Anomalous Periods</p>
                  <p className="text-white font-medium">{leakResult.highConsumptionPeriods}</p>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Consumption Forecast */}
        <div className="card-glow p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <TrendingUp className="w-5 h-5 text-emerald-400" />
              <h3 className="font-semibold text-white">7-Day Forecast</h3>
            </div>
            <button
              onClick={runForecast}
              disabled={!selectedMeter || loading.forecast}
              className="btn-primary text-xs py-1.5 px-3"
            >
              {loading.forecast ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
              Forecast
            </button>
          </div>
          <p className="text-xs text-slate-500">Predicts future water consumption based on historical patterns.</p>

          {forecastResult && chartData.length > 0 && (
            <div className="animate-fade-in">
              <ResponsiveContainer width="100%" height={200}>
                <AreaChart data={chartData} margin={{ top: 5, right: 5, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="actualGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#42A5F5" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#42A5F5" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="predictGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#7ED957" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#7ED957" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                  <XAxis dataKey="date" tick={{ fill: '#64748b', fontSize: 9 }} />
                  <YAxis tick={{ fill: '#64748b', fontSize: 9 }} />
                  <Tooltip
                    contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8 }}
                  />
                  <Area type="monotone" dataKey="actual" name="Actual" stroke="#42A5F5"
                    fill="url(#actualGrad)" strokeWidth={2} connectNulls={false} />
                  <Area type="monotone" dataKey="predicted" name="Predicted" stroke="#7ED957"
                    fill="url(#predictGrad)" strokeWidth={2} strokeDasharray="5 5" connectNulls={false} />
                </AreaChart>
              </ResponsiveContainer>
              <div className="flex items-center gap-4 text-xs text-slate-500 mt-2 justify-center">
                <div className="flex items-center gap-1.5"><div className="w-3 h-0.5 bg-primary-400" /><span>Historical</span></div>
                <div className="flex items-center gap-1.5"><div className="w-3 h-0.5 bg-secondary-400 opacity-60" style={{ borderTop: '2px dashed' }} /><span>Forecast</span></div>
              </div>
              <div className="mt-3 p-2 bg-slate-800/50 rounded-lg text-xs">
                <span className="text-slate-500">Avg daily consumption: </span>
                <span className="text-white font-medium">{forecastResult.avgDailyConsumption} m³</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Anomalies Detection */}
      <div className="card-glow p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-amber-400" />
            <h3 className="font-semibold text-white">Abnormal Consumption Detection</h3>
          </div>
          <button onClick={refetchAnomalies} className="btn-ghost text-xs">Refresh</button>
        </div>

        {anomaliesLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-5 h-5 text-primary-400 animate-spin" />
          </div>
        ) : !anomalies?.length ? (
          <div className="text-center py-8 text-slate-500">
            <Brain className="w-10 h-10 mx-auto mb-2 opacity-30" />
            <p>No anomalies detected in the fleet</p>
            <p className="text-xs mt-1">All meters operating within normal parameters</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Meter</th>
                  <th>Customer</th>
                  <th>Current Flow</th>
                  <th>Normal Avg</th>
                  <th>Anomaly Type</th>
                  <th>Deviation</th>
                </tr>
              </thead>
              <tbody>
                {anomalies.map((a, i) => (
                  <tr key={i}>
                    <td className="font-medium text-white">{a.meter_number}</td>
                    <td className="text-slate-400">{a.customer_name || '—'}</td>
                    <td className="font-mono text-amber-400">{Number(a.current_flow).toFixed(3)} L/min</td>
                    <td className="font-mono text-slate-400">{Number(a.avg_flow).toFixed(3)} L/min</td>
                    <td>
                      <span className={`text-xs px-2 py-0.5 rounded-full border ${
                        a.anomaly_type === 'high' ? 'bg-red-500/10 text-red-400 border-red-500/20' :
                        'bg-amber-500/10 text-amber-400 border-amber-500/20'
                      }`}>{a.anomaly_type}</span>
                    </td>
                    <td>
                      <span className="text-red-400 font-medium text-xs">
                        {a.avg_flow > 0 ? `+${((a.current_flow - a.avg_flow) / a.avg_flow * 100).toFixed(0)}%` : 'N/A'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
