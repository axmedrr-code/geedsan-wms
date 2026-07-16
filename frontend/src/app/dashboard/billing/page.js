'use client';
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { billingAPI } from '../../../lib/api';
import {
  FileText, Plus, ArrowRight, Search, Loader2, Play, Eye, History,
  Settings, CheckCircle, AlertTriangle, XCircle, ChevronDown, ChevronRight,
  RefreshCw, Ban, Send, Zap,
} from 'lucide-react';
import toast from 'react-hot-toast';

// ── helpers ───────────────────────────────────────────────────────────────────

const fmt = {
  usd:  v => v == null ? '—' : `$${Number(v).toFixed(2)}`,
  m3:   v => v == null ? '—' : `${Number(v).toFixed(3)} m³`,
  date: d => !d ? '—' : new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
  dt:   d => !d ? '—' : new Date(d).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
};

const prevMonthStart = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth() - 1, 1).toISOString().slice(0, 10); };
const prevMonthEnd   = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 0).toISOString().slice(0, 10); };

const STATUS_CHIP = {
  completed:    'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  partial:      'bg-amber-500/10   text-amber-400   border-amber-500/20',
  failed:       'bg-red-500/10     text-red-400     border-red-500/20',
  running:      'bg-blue-500/10    text-blue-400    border-blue-500/20',
  pending_post: 'bg-violet-500/10  text-violet-400  border-violet-500/20',
  cancelled:    'bg-slate-500/10   text-slate-400   border-slate-500/20',
  success:      'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  skipped:      'bg-slate-500/10   text-slate-400   border-slate-500/20',
  pending:      'bg-slate-500/10   text-slate-400   border-slate-500/20',
  paid:         'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  overdue:      'bg-red-500/10     text-red-400     border-red-500/20',
};

const Chip = ({ status }) => (
  <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${STATUS_CHIP[status] || 'bg-slate-800 text-slate-400 border-slate-700'}`}>
    {status?.replace('_', ' ')}
  </span>
);

const Stat = ({ label, value, sub, accent }) => (
  <div className="card-glow p-4">
    <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">{label}</p>
    <p className={`text-2xl font-bold font-display ${accent || 'text-white'}`}>{value}</p>
    {sub && <p className="text-xs text-slate-500 mt-0.5">{sub}</p>}
  </div>
);

// ── Tab config ────────────────────────────────────────────────────────────────

const TABS = [
  { id: 'invoices', label: 'Invoices',    icon: FileText },
  { id: 'preview',  label: 'Preview',     icon: Eye      },
  { id: 'run',      label: 'Run Billing', icon: Play     },
  { id: 'history',  label: 'History',     icon: History  },
  { id: 'settings', label: 'Settings',    icon: Settings },
];

// ── Invoices tab ──────────────────────────────────────────────────────────────

function InvoicesTab() {
  const [search, setSearch] = useState('');
  const { data, isLoading } = useQuery({
    queryKey: ['billing-list', search],
    queryFn: () => billingAPI.list({ search, limit: 100 }).then(r => r.data),
  });
  const invoices = data?.data || [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div className="relative max-w-xs flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
          <input className="input pl-9 w-full" placeholder="Search invoices…" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <Link href="/dashboard/billing/create" className="btn-primary text-sm flex items-center gap-2 flex-shrink-0">
          <Plus className="w-4 h-4" /> New Invoice
        </Link>
      </div>
      <div className="card-glow overflow-hidden">
        {isLoading
          ? <div className="flex items-center justify-center p-12"><Loader2 className="w-6 h-6 text-primary-400 animate-spin" /></div>
          : (
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr><th>Invoice</th><th>Customer</th><th>Amount</th><th>Due Date</th><th>Status</th><th></th></tr>
                </thead>
                <tbody>
                  {invoices.length === 0
                    ? <tr><td colSpan={6} className="text-center py-12 text-slate-500">No invoices found</td></tr>
                    : invoices.map(inv => (
                      <tr key={inv.id}>
                        <td><span className="font-mono text-xs text-primary-400">{inv.invoice_number}</span></td>
                        <td>{inv.customer_name || '—'}</td>
                        <td className="font-medium text-white">{fmt.usd(inv.total_amount)}</td>
                        <td className="text-slate-400 text-sm">{fmt.date(inv.due_date)}</td>
                        <td><Chip status={inv.status} /></td>
                        <td>
                          <Link href={`/dashboard/billing/${inv.id}`} className="text-primary-400 hover:text-primary-300">
                            <ArrowRight className="w-4 h-4" />
                          </Link>
                        </td>
                      </tr>
                    ))
                  }
                </tbody>
              </table>
            </div>
          )
        }
      </div>
    </div>
  );
}

// ── Preview tab ───────────────────────────────────────────────────────────────

function PreviewTab() {
  const [start, setStart] = useState(prevMonthStart());
  const [end,   setEnd]   = useState(prevMonthEnd());
  const [enabled, setEnabled] = useState(false);

  const { data, isFetching, refetch } = useQuery({
    queryKey: ['billing-preview', start, end],
    queryFn:  () => billingAPI.preview({ period_start: start, period_end: end }).then(r => r.data),
    enabled,
  });

  const runPreview = () => { setEnabled(true); setTimeout(() => refetch(), 0); };

  const flatRows = (data?.preview || []).flatMap(c => {
    if (!c.meters?.length) {
      return [{
        customerName: c.customerName, billingAccount: c.billingAccount || '—',
        meterNumber: '—', tariff: '—', unitPrice: null,
        previousReading: null, previousReadingDate: null,
        currentReading: null,  currentReadingDate: null,
        consumption: null, estimatedAmount: null,
        wouldSkip: c.wouldSkip, skipReason: c.skipReason,
      }];
    }
    return c.meters.map(m => ({
      customerName: c.customerName, billingAccount: c.billingAccount || '—',
      meterNumber: m.meterNumber, tariff: m.tariff, unitPrice: m.unitPrice,
      previousReading: m.previousReading, previousReadingDate: m.previousReadingDate,
      currentReading: m.currentReading,  currentReadingDate: m.currentReadingDate,
      consumption: m.consumption, estimatedAmount: m.estimatedAmount,
      wouldSkip: !!(m.skipReason || c.wouldSkip),
      skipReason: m.skipReason || c.skipReason,
    }));
  });

  return (
    <div className="space-y-4">
      <div className="card-glow p-4 flex flex-wrap gap-4 items-end">
        <div>
          <label className="block text-xs text-slate-400 mb-1">Period Start</label>
          <input type="date" className="input" value={start} onChange={e => setStart(e.target.value)} />
        </div>
        <div>
          <label className="block text-xs text-slate-400 mb-1">Period End</label>
          <input type="date" className="input" value={end} onChange={e => setEnd(e.target.value)} />
        </div>
        <button onClick={runPreview} disabled={isFetching} className="btn-primary flex items-center gap-2">
          {isFetching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Eye className="w-4 h-4" />}
          Run Preview
        </button>
      </div>

      {data && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Stat label="Customers"   value={data.totalCustomers} sub="active with meter" />
          <Stat label="Will Bill"   value={data.willBill}  accent="text-emerald-400" />
          <Stat label="Will Skip"   value={data.willSkip}  accent={data.willSkip > 0 ? 'text-amber-400' : undefined} />
          <Stat label="Est. Revenue" value={fmt.usd(data.totalEstimatedRevenue)} sub={fmt.m3(data.totalEstimatedConsumption)} accent="text-primary-400" />
        </div>
      )}

      {data && (
        <div className="card-glow overflow-hidden">
          <div className="overflow-x-auto">
            <table className="data-table text-sm">
              <thead>
                <tr>
                  <th>Customer</th><th>Billing Account</th><th>Meter</th>
                  <th>Prev Reading</th><th>Curr Reading</th><th>Consumption</th>
                  <th>Tariff</th><th>Unit Price</th><th>Est. Amount</th>
                  <th>Billing Period</th><th>Status</th>
                </tr>
              </thead>
              <tbody>
                {flatRows.length === 0
                  ? <tr><td colSpan={11} className="text-center py-10 text-slate-500">No customers match this period</td></tr>
                  : flatRows.map((r, i) => (
                    <tr key={i} className={r.wouldSkip ? 'opacity-55' : ''}>
                      <td className="font-medium text-white">{r.customerName}</td>
                      <td className="font-mono text-xs text-slate-400">{r.billingAccount}</td>
                      <td className="font-mono text-xs text-primary-400">{r.meterNumber}</td>
                      <td>
                        <div className="text-xs">
                          <div className="text-white">{r.previousReading != null ? `${r.previousReading.toFixed(3)} m³` : '—'}</div>
                          {r.previousReadingDate && <div className="text-slate-500">{fmt.date(r.previousReadingDate)}</div>}
                        </div>
                      </td>
                      <td>
                        <div className="text-xs">
                          <div className="text-white">{r.currentReading != null ? `${r.currentReading.toFixed(3)} m³` : '—'}</div>
                          {r.currentReadingDate && <div className="text-slate-500">{fmt.date(r.currentReadingDate)}</div>}
                        </div>
                      </td>
                      <td className={r.consumption > 0 ? 'text-white font-medium' : 'text-slate-500'}>
                        {r.consumption != null ? `${r.consumption.toFixed(3)} m³` : '—'}
                      </td>
                      <td className="capitalize text-slate-300 text-xs">{r.tariff || '—'}</td>
                      <td className="text-slate-300 text-xs">{r.unitPrice != null ? `$${r.unitPrice.toFixed(2)}/m³` : '—'}</td>
                      <td className={r.estimatedAmount > 0 ? 'font-bold text-emerald-400' : 'text-slate-500'}>
                        {r.estimatedAmount > 0 ? fmt.usd(r.estimatedAmount) : '—'}
                      </td>
                      <td className="text-xs text-slate-500">{data.periodStart} → {data.periodEnd}</td>
                      <td>
                        {r.skipReason
                          ? <span className="text-xs text-amber-400" title={r.skipReason}>Skip</span>
                          : <span className="text-xs text-emerald-400">Bill</span>
                        }
                      </td>
                    </tr>
                  ))
                }
              </tbody>
            </table>
          </div>
        </div>
      )}
      <p className="text-xs text-slate-600 text-right">Preview is read-only — no invoices are created.</p>
    </div>
  );
}

// ── Run Billing tab ───────────────────────────────────────────────────────────

function RunBillingTab() {
  const qc = useQueryClient();
  const [start,      setStart]      = useState(prevMonthStart());
  const [end,        setEnd]        = useState(prevMonthEnd());
  const [validated,  setValidated]  = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [validating, setValidating] = useState(false);

  const handleValidate = async () => {
    setValidating(true);
    setValidated(null);
    setConfirming(false);
    try {
      const r = await billingAPI.validate({ period_start: start, period_end: end });
      setValidated(r.data);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Validation error');
    } finally {
      setValidating(false);
    }
  };

  const runMutation = useMutation({
    mutationFn: () => billingAPI.run({ period_start: start, period_end: end }),
    onSuccess: (r) => {
      toast.success(`Billing run #${r.data.runId} created — ${r.data.ok} invoiced, ${r.data.skipped} skipped`);
      setConfirming(false);
      setValidated(null);
      qc.invalidateQueries(['billing-runs']);
    },
    onError: (err) => toast.error(err.response?.data?.error || 'Billing run failed'),
  });

  return (
    <div className="space-y-4">
      <div className="border border-amber-500/20 bg-amber-500/5 rounded-lg p-3 flex gap-3 text-sm text-amber-300">
        <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
        <span>Always run a <strong>Preview</strong> first. Then validate, review warnings, and confirm. A run creates billing cycles and invoices for all active customers.</span>
      </div>

      <div className="card-glow p-4 flex flex-wrap gap-4 items-end">
        <div>
          <label className="block text-xs text-slate-400 mb-1">Period Start</label>
          <input type="date" className="input" value={start} onChange={e => { setStart(e.target.value); setValidated(null); }} />
        </div>
        <div>
          <label className="block text-xs text-slate-400 mb-1">Period End</label>
          <input type="date" className="input" value={end} onChange={e => { setEnd(e.target.value); setValidated(null); }} />
        </div>
        <button onClick={handleValidate} disabled={validating} className="btn-secondary flex items-center gap-2">
          {validating ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
          Validate Period
        </button>
      </div>

      {validated && (
        <div className={`card-glow p-5 border-l-4 ${validated.valid ? 'border-l-emerald-500' : 'border-l-red-500'}`}>
          <div className="flex items-center gap-2 mb-3">
            {validated.valid
              ? <CheckCircle className="w-5 h-5 text-emerald-400" />
              : <XCircle    className="w-5 h-5 text-red-400" />
            }
            <span className={`font-semibold ${validated.valid ? 'text-emerald-400' : 'text-red-400'}`}>
              {validated.valid ? 'Validation passed' : 'Validation failed — run cannot proceed'}
            </span>
            <span className="text-slate-500 text-sm ml-1">({validated.totalCustomers} active customers in period)</span>
          </div>

          {validated.errors.length > 0 && (
            <div className="space-y-1.5 mb-3">
              {validated.errors.map((e, i) => (
                <div key={i} className="flex gap-2 text-sm text-red-400">
                  <XCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                  <span>{e.message}</span>
                </div>
              ))}
            </div>
          )}

          {validated.warnings.length > 0 && (
            <div className="space-y-1.5 mb-3">
              {validated.warnings.map((w, i) => (
                <div key={i} className="flex gap-2 text-sm text-amber-400">
                  <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                  <span>{w.message}</span>
                </div>
              ))}
            </div>
          )}

          {validated.customerIssues.length > 0 && (
            <details className="mt-2 mb-3">
              <summary className="text-xs text-slate-500 cursor-pointer hover:text-slate-300 select-none">
                {validated.customerIssues.length} customer-level issue(s) — expand
              </summary>
              <div className="mt-2 space-y-1 pl-3">
                {validated.customerIssues.map((c, i) => (
                  <div key={i} className={`text-xs flex gap-2 ${c.severity === 'info' ? 'text-slate-400' : 'text-amber-400'}`}>
                    <span>·</span>
                    <span><strong>{c.customerName}</strong>: {c.issue}</span>
                  </div>
                ))}
              </div>
            </details>
          )}

          {validated.valid && !confirming && (
            <button onClick={() => setConfirming(true)} className="mt-2 btn-primary flex items-center gap-2">
              <Play className="w-4 h-4" /> Execute Billing Run
            </button>
          )}

          {validated.valid && confirming && (
            <div className="mt-3 p-4 border border-amber-500/30 bg-amber-500/5 rounded-lg">
              <p className="text-sm text-amber-200 mb-3">
                This will create invoices for up to <strong>{(validated.totalCustomers || 0) - (validated.duplicateCount || 0)} customer(s)</strong> for period <strong>{validated.periodStart} → {validated.periodEnd}</strong>.
                Once invoices are posted they must be manually voided. Proceed?
              </p>
              <div className="flex gap-3">
                <button onClick={() => runMutation.mutate()} disabled={runMutation.isLoading} className="btn-primary flex items-center gap-2">
                  {runMutation.isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
                  Confirm &amp; Run
                </button>
                <button onClick={() => setConfirming(false)} className="btn-secondary">Back</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── History tab ───────────────────────────────────────────────────────────────

function HistoryTab() {
  const qc       = useQueryClient();
  const [expanded, setExpanded] = useState(null);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['billing-runs'],
    queryFn:  () => billingAPI.listRuns({ limit: 50 }).then(r => r.data),
  });

  const { data: detail, isLoading: detailLoading } = useQuery({
    queryKey: ['billing-run-detail', expanded],
    queryFn:  () => billingAPI.getRun(expanded).then(r => r.data),
    enabled:  expanded != null,
  });

  const cancelMut = useMutation({
    mutationFn: (id) => billingAPI.cancelRun(id, { reason: 'Manual cancel from Billing Center' }),
    onSuccess: (_, id) => { toast.success(`Run #${id} cancelled`); qc.invalidateQueries(['billing-runs']); setExpanded(null); },
    onError:   (err) => toast.error(err.response?.data?.error || 'Cancel failed'),
  });

  const postMut = useMutation({
    mutationFn: (id) => billingAPI.postRun(id),
    onSuccess: (r, id) => { toast.success(`Run #${id} posted — ${r.data.ok} invoices created`); qc.invalidateQueries(['billing-runs']); refetch(); },
    onError:   (err) => toast.error(err.response?.data?.error || 'Post failed'),
  });

  const runs = data?.data || [];

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <button onClick={() => refetch()} className="btn-secondary text-sm flex items-center gap-2">
          <RefreshCw className="w-3.5 h-3.5" /> Refresh
        </button>
      </div>

      <div className="card-glow overflow-hidden">
        {isLoading
          ? <div className="flex items-center justify-center p-12"><Loader2 className="w-6 h-6 text-primary-400 animate-spin" /></div>
          : (
            <div className="overflow-x-auto">
              <table className="data-table text-sm">
                <thead>
                  <tr>
                    <th>Run ID</th><th>Billing Period</th><th>Date</th>
                    <th>Billed</th><th>Skipped</th><th>Failed</th>
                    <th>Consumption</th><th>Revenue</th>
                    <th>Status</th><th>Executed By</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {runs.length === 0
                    ? <tr><td colSpan={11} className="text-center py-12 text-slate-500">No billing runs yet</td></tr>
                    : runs.map(run => (
                      <>
                        <tr
                          key={run.id}
                          className="cursor-pointer hover:bg-slate-800/30"
                          onClick={() => setExpanded(expanded === run.id ? null : run.id)}
                        >
                          <td className="font-mono text-xs text-primary-400">#{run.id}</td>
                          <td className="text-slate-300 text-xs whitespace-nowrap">{run.period_start} → {run.period_end}</td>
                          <td className="text-slate-400 text-xs whitespace-nowrap">{fmt.dt(run.started_at)}</td>
                          <td className="text-emerald-400 font-medium">{run.customers_ok}</td>
                          <td className="text-slate-400">{run.customers_skipped}</td>
                          <td className={run.customers_failed > 0 ? 'text-red-400' : 'text-slate-500'}>{run.customers_failed}</td>
                          <td className="text-slate-300 text-xs">{fmt.m3(run.total_consumption)}</td>
                          <td className="font-medium text-white">{fmt.usd(run.total_revenue)}</td>
                          <td><Chip status={run.status} /></td>
                          <td className="text-slate-500 text-xs">{run.triggered_by}</td>
                          <td>
                            <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
                              {['running', 'pending_post'].includes(run.status) && (
                                <button
                                  onClick={() => cancelMut.mutate(run.id)}
                                  disabled={cancelMut.isLoading}
                                  className="text-red-400 hover:text-red-300 text-xs flex items-center gap-1"
                                >
                                  <Ban className="w-3 h-3" /> Cancel
                                </button>
                              )}
                              {run.status === 'pending_post' && (
                                <button
                                  onClick={() => postMut.mutate(run.id)}
                                  disabled={postMut.isLoading}
                                  className="text-violet-400 hover:text-violet-300 text-xs flex items-center gap-1"
                                >
                                  <Send className="w-3 h-3" /> Post
                                </button>
                              )}
                              {expanded === run.id
                                ? <ChevronDown  className="w-4 h-4 text-slate-500" />
                                : <ChevronRight className="w-4 h-4 text-slate-500" />
                              }
                            </div>
                          </td>
                        </tr>

                        {expanded === run.id && (
                          <tr key={`${run.id}-items`}>
                            <td colSpan={11} className="p-0">
                              <div className="bg-slate-900/60 border-t border-b border-slate-800 p-4">
                                {detailLoading
                                  ? <div className="flex items-center gap-2 text-slate-500 text-sm"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
                                  : (
                                    <div className="overflow-x-auto">
                                      <table className="w-full text-xs">
                                        <thead>
                                          <tr className="text-slate-500 border-b border-slate-800">
                                            {['Customer','Billing Account','Meter','Amount','Invoice','Status','Note'].map(h => (
                                              <th key={h} className="text-left pb-2 pr-4 font-medium">{h}</th>
                                            ))}
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {(detail?.items || []).map(item => (
                                            <tr key={item.id} className="border-b border-slate-800/50">
                                              <td className="py-2 pr-4 text-white">{item.customer_name || item.customer_number || '—'}</td>
                                              <td className="py-2 pr-4 font-mono text-slate-400">{item.billing_account || '—'}</td>
                                              <td className="py-2 pr-4 font-mono text-slate-400">{item.meter_number || '—'}</td>
                                              <td className="py-2 pr-4 text-white">{fmt.usd(item.amount)}</td>
                                              <td className="py-2 pr-4 font-mono text-primary-400">{item.invoice_reference || '—'}</td>
                                              <td className="py-2 pr-4"><Chip status={item.billing_status} /></td>
                                              <td className="py-2 text-slate-500 max-w-xs truncate">{item.error_message || ''}</td>
                                            </tr>
                                          ))}
                                          {!detail?.items?.length && (
                                            <tr><td colSpan={7} className="py-4 text-center text-slate-600">No items</td></tr>
                                          )}
                                        </tbody>
                                      </table>
                                    </div>
                                  )
                                }
                              </div>
                            </td>
                          </tr>
                        )}
                      </>
                    ))
                  }
                </tbody>
              </table>
            </div>
          )
        }
      </div>
    </div>
  );
}

// ── Settings tab ──────────────────────────────────────────────────────────────

function SettingsTab() {
  const qc = useQueryClient();
  const { data: raw, isLoading } = useQuery({
    queryKey: ['billing-settings'],
    queryFn:  () => billingAPI.getSettings().then(r => r.data),
  });

  const [form, setForm] = useState(null);
  const settings = form || raw || {};
  const set = (k, v) => setForm(s => ({ ...(s || raw || {}), [k]: v }));

  const saveMut = useMutation({
    mutationFn: () => billingAPI.updateSettings(form || raw),
    onSuccess:  () => { toast.success('Settings saved'); qc.invalidateQueries(['billing-settings']); setForm(null); },
    onError:    (err) => toast.error(err.response?.data?.error || 'Save failed'),
  });

  if (isLoading) return <div className="flex items-center justify-center p-12"><Loader2 className="w-6 h-6 text-primary-400 animate-spin" /></div>;

  const Field = ({ label, children }) => (
    <div>
      <label className="block text-xs text-slate-400 uppercase tracking-wider mb-1.5">{label}</label>
      {children}
    </div>
  );

  return (
    <div className="max-w-xl space-y-5">
      <div className="card-glow p-6 space-y-5">
        <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider border-b border-slate-800 pb-3">
          Billing Engine Configuration
        </h2>

        <Field label="Billing Cycle">
          <select className="select" value={settings.billing_cycle || 'monthly'} onChange={e => set('billing_cycle', e.target.value)}>
            <option value="monthly">Monthly</option>
            <option value="weekly">Weekly</option>
            <option value="custom">Custom</option>
          </select>
        </Field>

        <Field label="Due Days (after period end)">
          <input type="number" min="1" max="365" className="input w-32" value={settings.due_days ?? 14} onChange={e => set('due_days', parseInt(e.target.value, 10))} />
          <p className="text-xs text-slate-600 mt-1">Invoice due date = period end + this many days</p>
        </Field>

        <Field label="Default Tariff">
          <select className="select" value={settings.default_tariff || 'residential'} onChange={e => set('default_tariff', e.target.value)}>
            <option value="residential">Residential — $1.20/m³</option>
            <option value="commercial">Commercial — $1.80/m³</option>
            <option value="industrial">Industrial — $2.40/m³</option>
            <option value="government">Government — $1.00/m³</option>
          </select>
        </Field>

        <Field label="Currency">
          <select className="select" value={settings.currency || 'USD'} onChange={e => set('currency', e.target.value)}>
            <option value="USD">USD — US Dollar</option>
            <option value="OMR">OMR — Omani Rial</option>
            <option value="AED">AED — UAE Dirham</option>
            <option value="SAR">SAR — Saudi Riyal</option>
          </select>
        </Field>

        <div className="space-y-3 pt-1">
          <label className="flex items-center gap-3 cursor-pointer">
            <input type="checkbox" checked={!!settings.auto_post_invoice} onChange={e => set('auto_post_invoice', e.target.checked)} className="w-4 h-4 rounded accent-primary-500" />
            <div>
              <div className="text-sm text-slate-200 font-medium">Auto-post invoices</div>
              <div className="text-xs text-slate-500">Post invoices immediately after billing run. If off, run creates billing cycles only — admin must post manually via History → Post.</div>
            </div>
          </label>
          <label className="flex items-center gap-3 cursor-pointer">
            <input type="checkbox" checked={!!settings.auto_sync_odoo} onChange={e => set('auto_sync_odoo', e.target.checked)} className="w-4 h-4 rounded accent-primary-500" />
            <div>
              <div className="text-sm text-slate-200 font-medium">Auto-sync to Odoo</div>
              <div className="text-xs text-slate-500">Enqueue invoices for Odoo sync immediately after posting.</div>
            </div>
          </label>
        </div>

        {raw?.updated_at && (
          <p className="text-xs text-slate-600 pt-1">
            Last saved: {fmt.dt(raw.updated_at)}{raw.updated_by ? ` by ${raw.updated_by}` : ''}
          </p>
        )}
      </div>

      <div className="flex gap-3">
        <button
          onClick={() => saveMut.mutate()}
          disabled={!form || saveMut.isLoading}
          className="btn-primary flex items-center gap-2"
        >
          {saveMut.isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
          Save Settings
        </button>
        {form && (
          <button onClick={() => setForm(null)} className="btn-secondary">Discard</button>
        )}
      </div>
    </div>
  );
}

// ── Billing Center root ───────────────────────────────────────────────────────

export default function BillingCenterPage() {
  const [activeTab, setActiveTab] = useState('invoices');

  return (
    <div className="p-4 lg:p-6 space-y-5 animate-fade-in">
      <div>
        <h1 className="text-2xl font-bold text-white font-display">Billing Center</h1>
        <p className="text-slate-400 text-sm mt-0.5">Manage invoices, run billing, review history, and configure billing settings.</p>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 border-b border-slate-800 overflow-x-auto">
        {TABS.map(tab => {
          const Icon   = tab.icon;
          const active = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 transition-colors ${
                active
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

      <div>
        {activeTab === 'invoices' && <InvoicesTab />}
        {activeTab === 'preview'  && <PreviewTab />}
        {activeTab === 'run'      && <RunBillingTab />}
        {activeTab === 'history'  && <HistoryTab />}
        {activeTab === 'settings' && <SettingsTab />}
      </div>
    </div>
  );
}
