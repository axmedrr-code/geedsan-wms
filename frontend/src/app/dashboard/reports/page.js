'use client';
import { useState, useCallback } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import {
  BarChart2, Download, FileText, TrendingUp, DollarSign,
  AlertCircle, Search, RefreshCw, Loader2, ChevronRight,
  Calendar, Users, Droplets, Activity, FileDown
} from 'lucide-react';
import {
  LineChart, Line, BarChart, Bar, AreaChart, Area,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend
} from 'recharts';
import { format, subMonths, startOfMonth } from 'date-fns';
import toast from 'react-hot-toast';
import api, { reportsAPI } from '../../../lib/api';

// ── helpers ───────────────────────────────────────────────────────────────────

const fmt = {
  usd:  v => v == null ? '—' : `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
  date: d => !d ? '—' : format(new Date(d), 'dd MMM yyyy'),
  dt:   d => !d ? '—' : format(new Date(d), 'dd MMM yyyy HH:mm'),
  m3:   v => v == null ? '—' : `${Number(v).toFixed(2)} m³`,
};

const defaultFrom = () => format(startOfMonth(subMonths(new Date(), 1)), 'yyyy-MM-dd');
const defaultTo   = () => format(new Date(), 'yyyy-MM-dd');

const STATUS_CHIP = {
  paid:      'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  pending:   'bg-slate-500/10 text-slate-400 border-slate-500/20',
  overdue:   'bg-red-500/10 text-red-400 border-red-500/20',
  cancelled: 'bg-slate-600/10 text-slate-500 border-slate-600/20',
};

function Chip({ status }) {
  return (
    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border capitalize ${STATUS_CHIP[status] || 'bg-slate-800 text-slate-400 border-slate-700'}`}>
      {status?.replace(/_/g, ' ')}
    </span>
  );
}

function StatCard({ icon: Icon, label, value, sub, color = 'primary' }) {
  const colors = {
    primary: 'from-primary-500/20 to-primary-600/5 border-primary-500/20 text-primary-400',
    green:   'from-emerald-500/20 to-emerald-600/5 border-emerald-500/20 text-emerald-400',
    red:     'from-red-500/20 to-red-600/5 border-red-500/20 text-red-400',
    amber:   'from-amber-500/20 to-amber-600/5 border-amber-500/20 text-amber-400',
    cyan:    'from-cyan-500/20 to-cyan-600/5 border-cyan-500/20 text-cyan-400',
    purple:  'from-purple-500/20 to-purple-600/5 border-purple-500/20 text-purple-400',
  };
  return (
    <div className={`relative overflow-hidden bg-gradient-to-br ${colors[color]} border rounded-xl p-5`}>
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs font-medium text-slate-400 uppercase tracking-wider">{label}</p>
          <p className="text-2xl font-bold text-white mt-1.5 font-display">{value ?? '—'}</p>
          {sub && <p className="text-xs text-slate-500 mt-1">{sub}</p>}
        </div>
        <div className="p-2.5 rounded-xl bg-current/10">
          <Icon className="w-5 h-5" />
        </div>
      </div>
    </div>
  );
}

const RevenueTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-slate-900 border border-slate-700 rounded-lg p-3 text-sm shadow-xl">
      <p className="text-slate-400 mb-1.5">{label}</p>
      {payload.map((p, i) => (
        <div key={i} className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full" style={{ background: p.color }} />
          <span className="text-slate-300">{p.name}:</span>
          <span className="text-white font-medium">{fmt.usd(p.value)}</span>
        </div>
      ))}
    </div>
  );
};

function Spinner() {
  return (
    <div className="flex items-center justify-center p-12">
      <div className="w-8 h-8 border-2 border-primary-500/30 border-t-primary-500 rounded-full animate-spin" />
    </div>
  );
}

function EmptyState({ icon: Icon = FileText, message = 'No data available' }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-slate-500">
      <Icon className="w-10 h-10 mb-2 opacity-30" />
      <p className="text-sm">{message}</p>
    </div>
  );
}

// ── Export helper ─────────────────────────────────────────────────────────────

function useExport(from, to) {
  const [exporting, setExporting] = useState(false);

  const doExport = useCallback(async (reportType, fileType = 'pdf') => {
    setExporting(true);
    try {
      const res = await reportsAPI.generate({ report_type: reportType, from, to, file_type: fileType });
      const downloadId = res.data?.report?.id || res.data?.id || res.data?.report_id;
      if (downloadId) {
        const blobRes = await reportsAPI.download(downloadId);
        const url = URL.createObjectURL(new Blob([blobRes.data], { type: blobRes.headers['content-type'] || 'application/octet-stream' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = `report_${reportType}_${fileType}.${fileType}`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        toast.success('Report generated — download started');
      } else {
        toast.error('Export failed: no download ID returned');
      }
    } catch (err) {
      toast.error(err.response?.data?.error || 'Export failed');
    } finally {
      setExporting(false);
    }
  }, [from, to]);

  return { doExport, exporting };
}

function ExportButtons({ reportType, from, to }) {
  const { doExport, exporting } = useExport(from, to);
  return (
    <div className="flex gap-2">
      {['pdf', 'xlsx', 'csv'].map(ft => (
        <button
          key={ft}
          onClick={() => doExport(reportType, ft)}
          disabled={exporting}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-700 bg-slate-800/50 text-slate-300 hover:text-white hover:border-slate-600 transition-colors disabled:opacity-50"
        >
          <FileDown className="w-3.5 h-3.5" />
          {ft.toUpperCase()}
        </button>
      ))}
    </div>
  );
}

// ── Revenue Tab ───────────────────────────────────────────────────────────────

function RevenueTab({ from, to }) {
  const [subTab, setSubTab] = useState('monthly');

  const { data, isLoading } = useQuery({
    queryKey: ['report-data-revenue', subTab, from, to],
    queryFn: () => api.get('/reports/data', { params: { type: `revenue_${subTab}`, from, to } }).then(r => r.data),
  });

  const rows = Array.isArray(data) ? data.slice(0, 50) : [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex gap-1 bg-slate-800/60 rounded-lg p-1">
          {['daily', 'monthly', 'annual'].map(t => (
            <button
              key={t}
              onClick={() => setSubTab(t)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md capitalize transition-colors ${
                subTab === t ? 'bg-primary-600 text-white' : 'text-slate-400 hover:text-slate-200'
              }`}
            >{t}</button>
          ))}
        </div>
        <ExportButtons reportType={`revenue_${subTab}`} from={from} to={to} />
      </div>

      <div className="card-glow overflow-hidden">
        {isLoading ? <Spinner /> : rows.length === 0 ? <EmptyState message="No revenue data for this period" /> : (
          <div className="overflow-x-auto">
            <table className="data-table text-sm">
              <thead>
                <tr>
                  <th>{subTab === 'daily' ? 'Date' : subTab === 'monthly' ? 'Month' : 'Year'}</th>
                  <th>Revenue</th>
                  <th>Invoiced</th>
                  <th>Collected</th>
                  <th>Outstanding</th>
                  <th>Invoices</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td className="text-slate-300">{r.period || r.date || r.month || r.year || '—'}</td>
                    <td className="font-medium text-white">{fmt.usd(r.revenue || r.total_revenue)}</td>
                    <td className="text-slate-300">{fmt.usd(r.invoiced || r.total_invoiced)}</td>
                    <td className="text-emerald-400">{fmt.usd(r.collected || r.total_collected)}</td>
                    <td className="text-amber-400">{fmt.usd(r.outstanding || r.total_outstanding)}</td>
                    <td className="text-slate-400">{r.invoice_count ?? r.count ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {rows.length === 50 && (
          <p className="text-xs text-slate-600 text-center py-2">Showing first 50 rows — export for full dataset</p>
        )}
      </div>
    </div>
  );
}

// ── Billing Tab ───────────────────────────────────────────────────────────────

function BillingTab({ from, to }) {
  const [subTab, setSubTab] = useState('summary');

  const { data: summaryData, isLoading: summaryLoading } = useQuery({
    queryKey: ['report-data-billing-summary', from, to],
    queryFn: () => api.get('/reports/data', { params: { type: 'billing_summary', from, to } }).then(r => r.data),
    enabled: subTab === 'summary',
  });

  const { data: outstandingData, isLoading: outstandingLoading } = useQuery({
    queryKey: ['report-data-billing-outstanding', from, to],
    queryFn: () => api.get('/reports/data', { params: { type: 'outstanding_balance', from, to } }).then(r => r.data),
    enabled: subTab === 'outstanding',
  });

  const rows = Array.isArray(subTab === 'summary' ? summaryData : outstandingData)
    ? (subTab === 'summary' ? summaryData : outstandingData).slice(0, 50)
    : [];
  const isLoading = subTab === 'summary' ? summaryLoading : outstandingLoading;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex gap-1 bg-slate-800/60 rounded-lg p-1">
          {[{ id: 'summary', label: 'Billing Summary' }, { id: 'outstanding', label: 'Outstanding Balance' }].map(t => (
            <button
              key={t.id}
              onClick={() => setSubTab(t.id)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                subTab === t.id ? 'bg-primary-600 text-white' : 'text-slate-400 hover:text-slate-200'
              }`}
            >{t.label}</button>
          ))}
        </div>
        <ExportButtons reportType={`billing_${subTab}`} from={from} to={to} />
      </div>

      <div className="card-glow overflow-hidden">
        {isLoading ? <Spinner /> : rows.length === 0 ? <EmptyState message="No billing data for this period" /> : (
          <div className="overflow-x-auto">
            {subTab === 'summary' ? (
              <table className="data-table text-sm">
                <thead>
                  <tr>
                    <th>Customer</th><th>Customer No.</th><th>Invoices</th>
                    <th>Billed</th><th>Paid</th><th>Outstanding</th><th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i}>
                      <td className="font-medium text-white">{r.customer_name || r.full_name || '—'}</td>
                      <td className="font-mono text-xs text-primary-400">{r.customer_number || '—'}</td>
                      <td className="text-slate-300">{r.invoice_count ?? '—'}</td>
                      <td className="text-slate-300">{fmt.usd(r.total_billed)}</td>
                      <td className="text-emerald-400">{fmt.usd(r.total_paid)}</td>
                      <td className={Number(r.total_outstanding) > 0 ? 'text-amber-400 font-medium' : 'text-slate-500'}>{fmt.usd(r.total_outstanding)}</td>
                      <td><Chip status={r.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <table className="data-table text-sm">
                <thead>
                  <tr>
                    <th>Customer</th><th>Invoice No.</th><th>Amount</th>
                    <th>Due Date</th><th>Days Overdue</th><th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i}>
                      <td className="font-medium text-white">{r.customer_name || '—'}</td>
                      <td className="font-mono text-xs text-primary-400">{r.invoice_number || '—'}</td>
                      <td className="font-medium text-amber-400">{fmt.usd(r.total_amount || r.amount)}</td>
                      <td className="text-slate-400">{fmt.date(r.due_date)}</td>
                      <td className={Number(r.days_overdue) > 0 ? 'text-red-400' : 'text-slate-500'}>
                        {r.days_overdue != null ? `${r.days_overdue}d` : '—'}
                      </td>
                      <td><Chip status={r.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
        {rows.length === 50 && (
          <p className="text-xs text-slate-600 text-center py-2">Showing first 50 rows — export for full dataset</p>
        )}
      </div>
    </div>
  );
}

// ── Payments Tab ──────────────────────────────────────────────────────────────

function PaymentsTab({ from, to }) {
  const { data, isLoading } = useQuery({
    queryKey: ['report-data-payments', from, to],
    queryFn: () => api.get('/reports/data', { params: { type: 'payment_collection', from, to } }).then(r => r.data),
  });

  const rows = Array.isArray(data) ? data.slice(0, 50) : [];

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <ExportButtons reportType="payment_collection" from={from} to={to} />
      </div>
      <div className="card-glow overflow-hidden">
        {isLoading ? <Spinner /> : rows.length === 0 ? <EmptyState message="No payments in this period" /> : (
          <div className="overflow-x-auto">
            <table className="data-table text-sm">
              <thead>
                <tr>
                  <th>Date</th><th>Customer</th><th>Amount</th>
                  <th>Method</th><th>Reference</th><th>Invoice</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td className="text-slate-300">{fmt.date(r.payment_date || r.paid_at || r.created_at)}</td>
                    <td className="font-medium text-white">{r.customer_name || '—'}</td>
                    <td className="font-medium text-emerald-400">{fmt.usd(r.amount)}</td>
                    <td className="text-slate-400 capitalize">{r.payment_method || r.method || '—'}</td>
                    <td className="font-mono text-xs text-slate-400">{r.reference || r.transaction_ref || '—'}</td>
                    <td className="font-mono text-xs text-primary-400">{r.invoice_number || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {rows.length === 50 && (
          <p className="text-xs text-slate-600 text-center py-2">Showing first 50 rows — export for full dataset</p>
        )}
      </div>
    </div>
  );
}

// ── Consumption Tab ───────────────────────────────────────────────────────────

function ConsumptionTab({ from, to }) {
  const { data, isLoading } = useQuery({
    queryKey: ['report-data-consumption', from, to],
    queryFn: () => api.get('/reports/data', { params: { type: 'consumption_summary', from, to } }).then(r => r.data),
  });

  const rows = Array.isArray(data) ? data : [];
  const topRows = rows.slice(0, 10);

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <ExportButtons reportType="consumption_summary" from={from} to={to} />
      </div>

      {!isLoading && topRows.length > 0 && (
        <div className="card-glow p-5">
          <h3 className="font-semibold text-white mb-4">Top 10 Consumers</h3>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={topRows} margin={{ top: 5, right: 5, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
              <XAxis dataKey="customer_name" tick={{ fill: '#64748b', fontSize: 9 }} tickFormatter={v => v?.substring(0, 10)} />
              <YAxis tick={{ fill: '#64748b', fontSize: 10 }} unit=" m³" />
              <Tooltip
                contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8 }}
                labelStyle={{ color: '#94a3b8' }}
                formatter={(v) => [`${Number(v).toFixed(2)} m³`, 'Consumption']}
              />
              <Bar dataKey="total_consumption" fill="#42A5F5" radius={[3, 3, 0, 0]} name="Consumption (m³)" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      <div className="card-glow overflow-hidden">
        {isLoading ? <Spinner /> : rows.length === 0 ? <EmptyState icon={Droplets} message="No consumption data for this period" /> : (
          <div className="overflow-x-auto">
            <table className="data-table text-sm">
              <thead>
                <tr>
                  <th>Meter</th><th>Customer</th><th>Consumption</th>
                  <th>Readings</th><th>Avg. Daily</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 50).map((r, i) => (
                  <tr key={i}>
                    <td className="font-mono text-xs text-primary-400">{r.meter_number || '—'}</td>
                    <td className="font-medium text-white">{r.customer_name || '—'}</td>
                    <td className="font-medium text-cyan-400">{fmt.m3(r.total_consumption)}</td>
                    <td className="text-slate-400">{r.reading_count ?? '—'}</td>
                    <td className="text-slate-400">{r.avg_daily != null ? fmt.m3(r.avg_daily) : '—'}</td>
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

// ── Operations Tab ────────────────────────────────────────────────────────────

function OperationsTab({ from, to }) {
  const [subTab, setSubTab] = useState('gateway');

  const typeMap = { gateway: 'gateway_activity', alarm: 'alarm_report', delivery: 'delivery_report' };

  const { data, isLoading } = useQuery({
    queryKey: ['report-data-ops', subTab, from, to],
    queryFn: () => api.get('/reports/data', { params: { type: typeMap[subTab], from, to } }).then(r => r.data),
  });

  const rows = Array.isArray(data) ? data.slice(0, 50) : [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex gap-1 bg-slate-800/60 rounded-lg p-1">
          {[{ id: 'gateway', label: 'Gateway Activity' }, { id: 'alarm', label: 'Alarm Report' }, { id: 'delivery', label: 'Delivery Report' }].map(t => (
            <button key={t.id} onClick={() => setSubTab(t.id)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${subTab === t.id ? 'bg-primary-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}
            >{t.label}</button>
          ))}
        </div>
        <ExportButtons reportType={typeMap[subTab]} from={from} to={to} />
      </div>

      <div className="card-glow overflow-hidden">
        {isLoading ? <Spinner /> : rows.length === 0 ? <EmptyState icon={Activity} message="No operations data for this period" /> : (
          <div className="overflow-x-auto">
            <table className="data-table text-sm">
              <thead>
                <tr>
                  {Object.keys(rows[0] || {}).slice(0, 7).map(k => (
                    <th key={k}>{k.replace(/_/g, ' ')}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    {Object.values(r).slice(0, 7).map((v, j) => (
                      <td key={j} className="text-slate-300 text-xs">
                        {v == null ? '—' : typeof v === 'string' && v.match(/^\d{4}-/) ? fmt.date(v) : String(v)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {rows.length === 50 && (
          <p className="text-xs text-slate-600 text-center py-2">Showing first 50 rows — export for full dataset</p>
        )}
      </div>
    </div>
  );
}

// ── Report History ────────────────────────────────────────────────────────────

function ReportHistory() {
  const { data, isLoading, refetch } = useQuery({
    queryKey: ['reports-list'],
    queryFn: () => reportsAPI.list().then(r => r.data),
  });

  const reports = Array.isArray(data) ? data : (data?.data || []);

  return (
    <div className="card-glow p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-semibold text-white">Report History</h3>
        <button onClick={() => refetch()} className="btn-secondary text-xs flex items-center gap-1.5">
          <RefreshCw className="w-3.5 h-3.5" /> Refresh
        </button>
      </div>
      {isLoading ? <Spinner /> : reports.length === 0 ? (
        <EmptyState icon={FileText} message="No reports generated yet" />
      ) : (
        <div className="overflow-x-auto">
          <table className="data-table text-sm">
            <thead>
              <tr>
                <th>Report Type</th><th>Period</th><th>Format</th><th>Generated</th><th>Size</th><th></th>
              </tr>
            </thead>
            <tbody>
              {reports.map(r => (
                <tr key={r.id}>
                  <td className="capitalize text-slate-300">{(r.report_type || r.type || '').replace(/_/g, ' ')}</td>
                  <td className="text-slate-400 text-xs">{r.from ? `${fmt.date(r.from)} – ${fmt.date(r.to)}` : '—'}</td>
                  <td><span className="font-mono text-xs text-slate-400 uppercase">{r.file_type || r.format || '—'}</span></td>
                  <td className="text-slate-500 text-xs">{fmt.dt(r.created_at)}</td>
                  <td className="text-slate-500 text-xs">{r.file_size ? `${Math.round(r.file_size / 1024)} KB` : '—'}</td>
                  <td>
                    <button
                      onClick={() => window.open(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000'}/api/reports/${r.id}/download`, '_blank')}
                      className="flex items-center gap-1 text-primary-400 hover:text-primary-300 text-xs"
                    >
                      <Download className="w-3.5 h-3.5" /> Download
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Page root ─────────────────────────────────────────────────────────────────

const TABS = [
  { id: 'revenue',     label: 'Revenue',     icon: TrendingUp  },
  { id: 'billing',     label: 'Billing',     icon: FileText    },
  { id: 'payments',    label: 'Payments',    icon: DollarSign  },
  { id: 'consumption', label: 'Consumption', icon: Droplets    },
  { id: 'operations',  label: 'Operations',  icon: Activity    },
];

export default function ReportsCenterPage() {
  const [activeTab, setActiveTab] = useState('revenue');
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo]     = useState(defaultTo);

  const { data: summary, isLoading: summaryLoading } = useQuery({
    queryKey: ['reports-summary'],
    queryFn: () => api.get('/reports/summary').then(r => r.data),
    staleTime: 60000,
  });

  const { data: revenueChart } = useQuery({
    queryKey: ['revenue-chart-6'],
    queryFn: () => api.get('/dashboard/revenue-chart', { params: { months: 6 } }).then(r => r.data),
    staleTime: 60000,
  });

  const chartData = Array.isArray(revenueChart) ? revenueChart : [];

  const handleExportAll = async () => {
    try {
      const res = await reportsAPI.generate({ report_type: 'billing_summary', from, to, file_type: 'pdf' });
      const id = res.data?.report?.id || res.data?.id || res.data?.report_id;
      if (id) {
        const blobRes = await reportsAPI.download(id);
        const url = URL.createObjectURL(new Blob([blobRes.data], { type: blobRes.headers['content-type'] || 'application/octet-stream' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = `billing_summary.pdf`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        toast.success('Full report export started');
      } else {
        toast.error('Export failed: no download ID returned');
      }
    } catch (err) {
      toast.error(err.response?.data?.error || 'Export failed');
    }
  };

  return (
    <div className="p-4 lg:p-6 space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white font-display">Reports Center</h1>
          <p className="text-slate-400 text-sm mt-0.5">Financial reports, billing analytics, and operational data</p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-xs text-slate-400 mb-1">From</label>
            <input type="date" className="input text-sm" value={from} onChange={e => setFrom(e.target.value)} />
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">To</label>
            <input type="date" className="input text-sm" value={to} onChange={e => setTo(e.target.value)} />
          </div>
          <button onClick={handleExportAll} className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary-600 hover:bg-primary-700 text-white text-sm font-medium transition-colors">
            <Download className="w-4 h-4" /> Export All
          </button>
        </div>
      </div>

      {/* Summary Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard icon={DollarSign}  label="Today's Revenue"    value={fmt.usd(summary?.revenueToday)}        color="primary" />
        <StatCard icon={TrendingUp}  label="Monthly Revenue"    value={fmt.usd(summary?.revenueThisMonth)}    color="green"   />
        <StatCard icon={AlertCircle} label="Outstanding Balance" value={fmt.usd(summary?.totalOutstanding)}   color="amber"   />
        <StatCard icon={BarChart2}   label="Total Collected"    value={fmt.usd(summary?.totalCollected)}      color="cyan"    sub={`${summary?.paidCount ?? '—'} invoices paid`} />
      </div>

      {/* Revenue Trend Chart */}
      <div className="card-glow p-5">
        <div className="flex items-center justify-between mb-5">
          <div>
            <h3 className="font-semibold text-white">Revenue Trend</h3>
            <p className="text-xs text-slate-500 mt-0.5">Last 6 months</p>
          </div>
          <TrendingUp className="w-4 h-4 text-slate-500" />
        </div>
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={chartData} margin={{ top: 5, right: 10, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id="revGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#10b981" stopOpacity={0.15} />
                <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
            <XAxis dataKey="month" tick={{ fill: '#64748b', fontSize: 10 }} />
            <YAxis tick={{ fill: '#64748b', fontSize: 10 }} tickFormatter={v => `$${(v / 1000).toFixed(0)}k`} />
            <Tooltip content={<RevenueTooltip />} />
            <Legend wrapperStyle={{ color: '#94a3b8', fontSize: 12 }} />
            <Line type="monotone" dataKey="revenue"  name="Revenue"  stroke="#10b981" strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="invoiced" name="Invoiced" stroke="#42A5F5" strokeWidth={2} dot={false} strokeDasharray="5 3" />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Report Type Tabs */}
      <div>
        <div className="flex gap-1 border-b border-slate-800 overflow-x-auto">
          {TABS.map(tab => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 transition-colors ${
                  activeTab === tab.id
                    ? 'border-primary-500 text-primary-400'
                    : 'border-transparent text-slate-400 hover:text-slate-200 hover:border-slate-700'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {tab.label}
              </button>
            );
          })}
        </div>

        <div className="mt-5">
          {activeTab === 'revenue'     && <RevenueTab     from={from} to={to} />}
          {activeTab === 'billing'     && <BillingTab     from={from} to={to} />}
          {activeTab === 'payments'    && <PaymentsTab    from={from} to={to} />}
          {activeTab === 'consumption' && <ConsumptionTab from={from} to={to} />}
          {activeTab === 'operations'  && <OperationsTab  from={from} to={to} />}
        </div>
      </div>

      {/* Report History */}
      <ReportHistory />
    </div>
  );
}
