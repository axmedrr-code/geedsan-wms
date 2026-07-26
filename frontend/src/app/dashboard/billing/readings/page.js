'use client';
import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { meterReadingsAPI, metersAPI } from '../../../../lib/api';
import { Gauge, Plus, Loader2, X, Save, ArrowLeft, AlertTriangle, Radio, PenLine } from 'lucide-react';
import toast from 'react-hot-toast';

const SOURCE_CLS = {
  lorawan: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  manual:  'bg-amber-500/10 text-amber-400 border-amber-500/20',
};

function ManualReadingForm({ meters, initialMeterId, onSave, onCancel, loading }) {
  const [form, setForm] = useState({ meter_id: initialMeterId || '', reading_value: '', timestamp: '', notes: '' });
  const selectedMeter = meters.find(m => m.id === form.meter_id);

  return (
    <div className="card-glow border-primary-500/20 p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-white">Manual Reading Entry</h3>
        <button onClick={onCancel} className="btn-ghost p-1.5"><X className="w-4 h-4" /></button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="sm:col-span-2">
          <label className="block text-xs text-slate-400 mb-1 font-medium">Meter <span className="text-red-400">*</span></label>
          <select className="select" value={form.meter_id} onChange={e => setForm(p => ({ ...p, meter_id: e.target.value }))}>
            <option value="">Select a meter</option>
            {meters.map(m => (
              <option key={m.id} value={m.id}>
                {m.meter_number} {m.water_type ? `(${m.water_type})` : ''} — {m.reading_mode === 'manual' ? 'Manual' : 'Automatic'}
              </option>
            ))}
          </select>
          {selectedMeter && selectedMeter.reading_mode !== 'manual' && (
            <p className="text-xs text-amber-400 flex items-center gap-1.5 mt-1.5">
              <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
              This meter is classified Automatic (LoRaWAN) — entering a manual reading is allowed (e.g. the meter went dark and needs a catch-up reading), but double-check this is intentional.
            </p>
          )}
        </div>
        <div>
          <label className="block text-xs text-slate-400 mb-1 font-medium">Reading Value (m³) <span className="text-red-400">*</span></label>
          <input
            type="number" step="0.001" min="0" className="input"
            placeholder="e.g. 1245.678"
            value={form.reading_value}
            onChange={e => setForm(p => ({ ...p, reading_value: e.target.value }))}
          />
        </div>
        <div>
          <label className="block text-xs text-slate-400 mb-1 font-medium">Timestamp</label>
          <input
            type="datetime-local" className="input"
            value={form.timestamp}
            onChange={e => setForm(p => ({ ...p, timestamp: e.target.value }))}
          />
          <p className="text-xs text-slate-500 mt-1">Leave blank to use the current time.</p>
        </div>
        <div className="sm:col-span-2">
          <label className="block text-xs text-slate-400 mb-1 font-medium">Notes</label>
          <input
            className="input" placeholder="Optional notes"
            value={form.notes}
            onChange={e => setForm(p => ({ ...p, notes: e.target.value }))}
          />
        </div>
      </div>

      <div className="flex justify-end gap-3">
        <button onClick={onCancel} className="btn-secondary">Cancel</button>
        <button
          onClick={() => onSave({
            meter_id: form.meter_id,
            reading_value: Number(form.reading_value),
            timestamp: form.timestamp ? new Date(form.timestamp).toISOString() : undefined,
            notes: form.notes || undefined,
          })}
          disabled={loading || !form.meter_id || form.reading_value === ''}
          className="btn-primary"
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          Save Reading
        </button>
      </div>
    </div>
  );
}

export default function MeterReadingsPage() {
  const qc = useQueryClient();
  const searchParams = useSearchParams();
  const preselectedMeterId = searchParams.get('meter_id') || '';
  const [showEntry, setShowEntry] = useState(!!preselectedMeterId);
  const [sourceFilter, setSourceFilter] = useState('');

  const { data: metersData } = useQuery({
    queryKey: ['meters-list-readings'],
    queryFn: () => metersAPI.list({ limit: 500 }).then(r => r.data),
  });
  const meters = metersData?.data || [];

  const { data: readingsData, isLoading } = useQuery({
    queryKey: ['meter-readings', sourceFilter],
    queryFn: () => meterReadingsAPI.list({ limit: 100, source: sourceFilter || undefined }).then(r => r.data),
  });
  const readings = readingsData?.data || [];

  const createMut = useMutation({
    mutationFn: (d) => meterReadingsAPI.create(d),
    onSuccess: (res) => {
      toast.success('Reading recorded');
      if (res.data?.warning) toast(res.data.warning, { icon: '⚠️' });
      qc.invalidateQueries({ queryKey: ['meter-readings'] });
      setShowEntry(false);
    },
    onError: (err) => toast.error(err.response?.data?.error || 'Failed to record reading'),
  });

  const fmtDt = (d) => !d ? '—' : new Date(d).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  return (
    <div className="p-4 lg:p-6 space-y-5 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2 text-sm text-slate-500 mb-1">
            <Link href="/dashboard/billing" className="flex items-center gap-1 hover:text-slate-300">
              <ArrowLeft className="w-3.5 h-3.5" /> Billing Center
            </Link>
          </div>
          <h1 className="text-2xl font-bold text-white font-display">Meter Readings</h1>
          <p className="text-slate-400 text-sm mt-0.5">LoRaWAN telemetry and manual entries, across all meters</p>
        </div>
        <button onClick={() => setShowEntry(true)} className="btn-primary text-sm">
          <Plus className="w-4 h-4" /> Manual Entry
        </button>
      </div>

      {showEntry && (
        <ManualReadingForm
          meters={meters}
          initialMeterId={preselectedMeterId}
          onSave={(d) => createMut.mutate(d)}
          onCancel={() => setShowEntry(false)}
          loading={createMut.isPending}
        />
      )}

      <div className="flex gap-2">
        {['', 'lorawan', 'manual'].map(s => (
          <button
            key={s || 'all'}
            onClick={() => setSourceFilter(s)}
            className={`text-xs px-3 py-1.5 rounded-full border font-medium capitalize ${sourceFilter === s ? 'bg-primary-500/10 text-primary-400 border-primary-500/20' : 'text-slate-400 border-slate-700 hover:text-slate-200'}`}
          >
            {s || 'All'}
          </button>
        ))}
      </div>

      <div className="card-glow overflow-hidden">
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Timestamp</th>
                <th>Meter</th>
                <th>Water Type</th>
                <th>Reading (m³)</th>
                <th>Source</th>
                <th>Entered By</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <tr key={i}>
                    {Array.from({ length: 6 }).map((_, j) => (
                      <td key={j}><div className="h-4 bg-slate-800 rounded animate-pulse" /></td>
                    ))}
                  </tr>
                ))
              ) : readings.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-center py-16 text-slate-500">
                    <Gauge className="w-10 h-10 mx-auto mb-3 opacity-25" />
                    <p className="font-medium">No readings found</p>
                  </td>
                </tr>
              ) : (
                readings.map(r => (
                  <tr key={r.id}>
                    <td className="text-slate-300 text-sm">{fmtDt(r.timestamp)}</td>
                    <td><span className="font-mono text-sm text-white">{r.meter_number}</span></td>
                    <td><span className="text-slate-400 text-sm">{r.water_type || '—'}</span></td>
                    <td className="text-slate-300 text-sm">{Number(r.total_consumption ?? 0).toFixed(3)}</td>
                    <td>
                      <span className={`text-xs px-2 py-0.5 rounded-full border font-medium capitalize inline-flex items-center gap-1 ${SOURCE_CLS[r.source] || 'bg-slate-700/50 text-slate-400 border-slate-700'}`}>
                        {r.source === 'manual' ? <PenLine className="w-3 h-3" /> : <Radio className="w-3 h-3" />}
                        {r.source || 'lorawan'}
                      </span>
                    </td>
                    <td className="text-slate-400 text-sm">{r.entered_by_name || '—'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
