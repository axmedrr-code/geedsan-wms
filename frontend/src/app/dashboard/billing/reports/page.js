'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { billingReportsAPI, customersAPI, zonesAPI } from '../../../../lib/api';
import {
  FileText, User, MapPin, Clock, AlertTriangle, Droplets, TrendingUp,
  ChevronDown, Loader2, Download,
} from 'lucide-react';
import toast from 'react-hot-toast';

const fmt = {
  usd:  v => v == null ? '—' : `$${Number(v).toFixed(2)}`,
  m3:   v => v == null ? '—' : `${Number(v).toFixed(3)} m³`,
  date: d => !d ? '—' : new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
  pct:  v => v == null ? '—' : `${Number(v).toFixed(1)}%`,
};

const STATUS_CHIP = {
  paid:    'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  pending: 'bg-slate-500/10   text-slate-400   border-slate-500/20',
  overdue: 'bg-red-500/10     text-red-400     border-red-500/20',
};
const Chip = ({ status }) => (
  <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${STATUS_CHIP[status] || 'bg-slate-800 text-slate-400 border-slate-700'}`}>
    {status}
  </span>
);

const REPORT_TYPES = [
  { id: 'customer-statement', label: 'Customer Statement', icon: User,          desc: 'All invoices and payments for a specific customer' },
  { id: 'zone',               label: 'Zone Billing',       icon: MapPin,         desc: 'Billing summary for all customers in a zone' },
  { id: 'aging',              label: 'Aging Report',       icon: Clock,          desc: 'Outstanding balances grouped by age (30/60/90+ days)' },
  { id: 'unpaid',             label: 'Unpaid Invoices',    icon: AlertTriangle,  desc: 'All outstanding invoices, optionally filtered by zone' },
  { id: 'consumption',        label: 'Consumption Report', icon: Droplets,       desc: 'Water usage per customer for a period' },
  { id: 'revenue',            label: 'Revenue Report',     icon: TrendingUp,     desc: 'Revenue vs invoiced by month/day/year' },
];

// ── Customer Statement ────────────────────────────────────────────────────────

function CustomerStatementReport() {
  const [customerId, setCustomerId] = useState('');
  const [from, setFrom] = useState('');
  const [to,   setTo]   = useState('');

  const { data: customers = [] } = useQuery({
    queryKey: ['customers-for-report'],
    queryFn: () => customersAPI.list({ limit: 500 }).then(r => r.data?.data || []),
  });

  const { data, isFetching, refetch } = useQuery({
    queryKey: ['report-customer-statement', customerId, from, to],
    queryFn: () => billingReportsAPI.customerStatement(customerId, { from: from || undefined, to: to || undefined }).then(r => r.data),
    enabled: false,
  });

  return (
    <div className="space-y-4">
      <div className="card-glow p-4 flex flex-wrap gap-3 items-end">
        <div className="flex-1 min-w-40">
          <label className="text-xs text-slate-400 block mb-1">Customer *</label>
          <select className="input w-full" value={customerId} onChange={e => setCustomerId(e.target.value)}>
            <option value="">Select customer…</option>
            {customers.map(c => <option key={c.id} value={c.id}>{c.full_name} ({c.house_number})</option>)}
          </select>
        </div>
        <div>
          <label className="text-xs text-slate-400 block mb-1">From</label>
          <input type="date" className="input" value={from} onChange={e => setFrom(e.target.value)} />
        </div>
        <div>
          <label className="text-xs text-slate-400 block mb-1">To</label>
          <input type="date" className="input" value={to} onChange={e => setTo(e.target.value)} />
        </div>
        <button onClick={() => customerId ? refetch() : toast.error('Select a customer')} disabled={isFetching} className="btn-primary flex items-center gap-2">
          {isFetching ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />} Generate
        </button>
      </div>
      {data && (
        <div className="space-y-4">
          <div className="card-glow p-4">
            <h3 className="font-semibold text-white mb-1">{data.customer.full_name}</h3>
            <p className="text-xs text-slate-400">House #: {data.customer.house_number} · {data.customer.phone || '—'}</p>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3">
              <div><p className="text-xs text-slate-500">Total Invoiced</p><p className="text-white font-bold">{fmt.usd(data.summary.total_invoiced)}</p></div>
              <div><p className="text-xs text-slate-500">Total Paid</p><p className="text-emerald-400 font-bold">{fmt.usd(data.summary.total_paid)}</p></div>
              <div><p className="text-xs text-slate-500">Balance</p><p className="text-amber-400 font-bold">{fmt.usd(data.summary.total_balance)}</p></div>
              <div><p className="text-xs text-slate-500">Overdue</p><p className="text-red-400 font-bold">{data.summary.overdue_count} invoice(s)</p></div>
            </div>
          </div>
          <div className="card-glow overflow-hidden">
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead><tr><th>Invoice #</th><th>Issue Date</th><th>Due Date</th><th>Amount</th><th>Paid</th><th>Balance</th><th>Status</th></tr></thead>
                <tbody>
                  {data.invoices.map(inv => (
                    <tr key={inv.id}>
                      <td className="font-mono text-xs text-primary-400">{inv.invoice_number}</td>
                      <td className="text-slate-400 text-sm">{fmt.date(inv.issue_date)}</td>
                      <td className="text-slate-400 text-sm">{fmt.date(inv.due_date)}</td>
                      <td>{fmt.usd(inv.total_amount)}</td>
                      <td className="text-emerald-400">{fmt.usd(inv.paid_amount)}</td>
                      <td className="text-amber-400">{fmt.usd(inv.balance)}</td>
                      <td><Chip status={inv.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Zone Billing ──────────────────────────────────────────────────────────────

function ZoneBillingReport() {
  const [zoneId, setZoneId] = useState('');
  const [from, setFrom] = useState('');
  const [to,   setTo]   = useState('');

  const { data: zones = [] } = useQuery({
    queryKey: ['zones-for-report', 'active'],
    queryFn: () => zonesAPI.list({ status: 'active' }).then(r => r.data || []),
  });

  const { data, isFetching, refetch } = useQuery({
    queryKey: ['report-zone', zoneId, from, to],
    queryFn: () => billingReportsAPI.zone(zoneId, { from: from || undefined, to: to || undefined }).then(r => r.data),
    enabled: false,
  });

  return (
    <div className="space-y-4">
      <div className="card-glow p-4 flex flex-wrap gap-3 items-end">
        <div className="flex-1 min-w-40">
          <label className="text-xs text-slate-400 block mb-1">Zone *</label>
          <select className="input w-full" value={zoneId} onChange={e => setZoneId(e.target.value)}>
            <option value="">Select zone…</option>
            {zones.map(z => <option key={z.id} value={z.id}>{z.zone_name}</option>)}
          </select>
        </div>
        <div><label className="text-xs text-slate-400 block mb-1">From</label><input type="date" className="input" value={from} onChange={e => setFrom(e.target.value)} /></div>
        <div><label className="text-xs text-slate-400 block mb-1">To</label><input type="date" className="input" value={to} onChange={e => setTo(e.target.value)} /></div>
        <button onClick={() => zoneId ? refetch() : toast.error('Select a zone')} disabled={isFetching} className="btn-primary flex items-center gap-2">
          {isFetching ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />} Generate
        </button>
      </div>
      {data && (
        <div className="space-y-4">
          <div className="card-glow p-4">
            <h3 className="font-semibold text-white mb-3">{data.zone.zone_name}</h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div><p className="text-xs text-slate-500">Customers</p><p className="text-white font-bold">{data.summary.customer_count}</p></div>
              <div><p className="text-xs text-slate-500">Total Invoiced</p><p className="text-white font-bold">{fmt.usd(data.summary.total_invoiced)}</p></div>
              <div><p className="text-xs text-slate-500">Total Paid</p><p className="text-emerald-400 font-bold">{fmt.usd(data.summary.total_paid)}</p></div>
              <div><p className="text-xs text-slate-500">Outstanding</p><p className="text-amber-400 font-bold">{fmt.usd(data.summary.outstanding)}</p></div>
            </div>
          </div>
          <div className="card-glow overflow-hidden">
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead><tr><th>House #</th><th>Customer</th><th>Tariff</th><th>Invoices</th><th>Invoiced</th><th>Paid</th><th>Outstanding</th><th>Overdue</th></tr></thead>
                <tbody>
                  {data.customers.map(c => (
                    <tr key={c.id}>
                      <td className="font-mono text-xs text-slate-400">{c.house_number}</td>
                      <td>{c.full_name}</td>
                      <td className="capitalize text-slate-400 text-sm">{c.tariff_type}</td>
                      <td>{c.invoice_count}</td>
                      <td>{fmt.usd(c.total_invoiced)}</td>
                      <td className="text-emerald-400">{fmt.usd(c.total_paid)}</td>
                      <td className="text-amber-400">{fmt.usd(c.outstanding)}</td>
                      <td className="text-red-400">{c.overdue_count > 0 ? c.overdue_count : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Aging Report ──────────────────────────────────────────────────────────────

function AgingReport() {
  const { data, isFetching, refetch } = useQuery({
    queryKey: ['report-aging'],
    queryFn: () => billingReportsAPI.aging().then(r => r.data),
    enabled: false,
  });

  return (
    <div className="space-y-4">
      <div className="card-glow p-4 flex items-center gap-3">
        <p className="text-sm text-slate-400 flex-1">Shows all customers with outstanding balances, grouped by days overdue.</p>
        <button onClick={() => refetch()} disabled={isFetching} className="btn-primary flex items-center gap-2">
          {isFetching ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />} Run Report
        </button>
      </div>
      {data && (
        <div className="space-y-4">
          <div className="card-glow p-4">
            <div className="grid grid-cols-3 md:grid-cols-6 gap-3 text-center">
              <div><p className="text-xs text-slate-500">Customers</p><p className="text-white font-bold">{data.summary.customer_count}</p></div>
              <div><p className="text-xs text-emerald-400 text-xs">Current</p><p className="text-white font-bold">{fmt.usd(data.summary.current_balance)}</p></div>
              <div><p className="text-xs text-amber-300 text-xs">1–30 days</p><p className="text-white font-bold">{fmt.usd(data.summary.overdue_30)}</p></div>
              <div><p className="text-xs text-amber-400 text-xs">31–60 days</p><p className="text-white font-bold">{fmt.usd(data.summary.overdue_60)}</p></div>
              <div><p className="text-xs text-orange-400 text-xs">61–90 days</p><p className="text-white font-bold">{fmt.usd(data.summary.overdue_90)}</p></div>
              <div><p className="text-xs text-red-400 text-xs">90+ days</p><p className="text-white font-bold">{fmt.usd(data.summary.overdue_90_plus)}</p></div>
            </div>
            <div className="mt-3 pt-3 border-t border-slate-700 text-right">
              <p className="text-xs text-slate-500">Total Outstanding</p>
              <p className="text-xl font-bold text-red-400">{fmt.usd(data.summary.total_outstanding)}</p>
            </div>
          </div>
          <div className="card-glow overflow-hidden">
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead><tr><th>House #</th><th>Customer</th><th>Zone</th><th>Current</th><th>1–30 d</th><th>31–60 d</th><th>61–90 d</th><th>90+ d</th><th>Total</th></tr></thead>
                <tbody>
                  {data.customers.map(c => (
                    <tr key={c.id}>
                      <td className="font-mono text-xs text-slate-400">{c.house_number}</td>
                      <td>{c.full_name}</td>
                      <td className="text-slate-400 text-sm">{c.zone_name || '—'}</td>
                      <td>{fmt.usd(c.current_balance)}</td>
                      <td className="text-amber-300">{Number(c.overdue_30) > 0 ? fmt.usd(c.overdue_30) : '—'}</td>
                      <td className="text-amber-400">{Number(c.overdue_60) > 0 ? fmt.usd(c.overdue_60) : '—'}</td>
                      <td className="text-orange-400">{Number(c.overdue_90) > 0 ? fmt.usd(c.overdue_90) : '—'}</td>
                      <td className="text-red-400">{Number(c.overdue_90_plus) > 0 ? fmt.usd(c.overdue_90_plus) : '—'}</td>
                      <td className="font-bold text-white">{fmt.usd(c.total_outstanding)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Unpaid Invoices ───────────────────────────────────────────────────────────

function UnpaidInvoicesReport() {
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [zoneId, setZoneId] = useState('');

  const { data: zones = [] } = useQuery({ queryKey: ['zones-for-report', 'active'], queryFn: () => zonesAPI.list({ status: 'active' }).then(r => r.data || []) });

  const { data, isFetching, refetch } = useQuery({
    queryKey: ['report-unpaid', overdueOnly, zoneId],
    queryFn: () => billingReportsAPI.unpaid({ overdue_only: overdueOnly ? 'true' : undefined, zone_id: zoneId || undefined }).then(r => r.data),
    enabled: false,
  });

  return (
    <div className="space-y-4">
      <div className="card-glow p-4 flex flex-wrap gap-3 items-end">
        <div className="flex-1 min-w-40">
          <label className="text-xs text-slate-400 block mb-1">Zone (optional)</label>
          <select className="input w-full" value={zoneId} onChange={e => setZoneId(e.target.value)}>
            <option value="">All zones</option>
            {zones.map(z => <option key={z.id} value={z.id}>{z.zone_name}</option>)}
          </select>
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
          <input type="checkbox" checked={overdueOnly} onChange={e => setOverdueOnly(e.target.checked)} className="w-4 h-4" />
          Overdue only
        </label>
        <button onClick={() => refetch()} disabled={isFetching} className="btn-primary flex items-center gap-2">
          {isFetching ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />} Generate
        </button>
      </div>
      {data && (
        <div className="space-y-4">
          <div className="card-glow p-4 flex gap-6">
            <div><p className="text-xs text-slate-500">Unpaid Invoices</p><p className="text-2xl font-bold text-white">{data.count}</p></div>
            <div><p className="text-xs text-slate-500">Total Outstanding</p><p className="text-2xl font-bold text-red-400">{fmt.usd(data.total_balance)}</p></div>
          </div>
          <div className="card-glow overflow-hidden">
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead><tr><th>Invoice #</th><th>House #</th><th>Customer</th><th>Zone</th><th>Due Date</th><th>Days Overdue</th><th>Balance</th><th>Status</th></tr></thead>
                <tbody>
                  {data.invoices.map(inv => (
                    <tr key={inv.id}>
                      <td className="font-mono text-xs text-primary-400">{inv.invoice_number}</td>
                      <td className="font-mono text-xs text-slate-400">{inv.house_number}</td>
                      <td>{inv.full_name}</td>
                      <td className="text-slate-400 text-sm">{inv.zone_name || '—'}</td>
                      <td className="text-slate-400 text-sm">{fmt.date(inv.due_date)}</td>
                      <td className={inv.days_overdue > 0 ? 'text-red-400 font-medium' : 'text-slate-500'}>{inv.days_overdue > 0 ? `${inv.days_overdue}d` : '—'}</td>
                      <td className="text-amber-400 font-medium">{fmt.usd(inv.balance)}</td>
                      <td><Chip status={inv.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Consumption Report ────────────────────────────────────────────────────────

function ConsumptionReport() {
  const [from, setFrom] = useState('');
  const [to,   setTo]   = useState('');
  const [zoneId, setZoneId] = useState('');

  const { data: zones = [] } = useQuery({ queryKey: ['zones-for-report', 'active'], queryFn: () => zonesAPI.list({ status: 'active' }).then(r => r.data || []) });

  const { data, isFetching, refetch } = useQuery({
    queryKey: ['report-consumption', from, to, zoneId],
    queryFn: () => billingReportsAPI.consumption({ from: from || undefined, to: to || undefined, zone_id: zoneId || undefined }).then(r => r.data),
    enabled: false,
  });

  return (
    <div className="space-y-4">
      <div className="card-glow p-4 flex flex-wrap gap-3 items-end">
        <div><label className="text-xs text-slate-400 block mb-1">From</label><input type="date" className="input" value={from} onChange={e => setFrom(e.target.value)} /></div>
        <div><label className="text-xs text-slate-400 block mb-1">To</label><input type="date" className="input" value={to} onChange={e => setTo(e.target.value)} /></div>
        <div className="flex-1 min-w-36">
          <label className="text-xs text-slate-400 block mb-1">Zone (optional)</label>
          <select className="input w-full" value={zoneId} onChange={e => setZoneId(e.target.value)}>
            <option value="">All zones</option>
            {zones.map(z => <option key={z.id} value={z.id}>{z.zone_name}</option>)}
          </select>
        </div>
        <button onClick={() => refetch()} disabled={isFetching} className="btn-primary flex items-center gap-2">
          {isFetching ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />} Generate
        </button>
      </div>
      {data && (
        <div className="space-y-4">
          <div className="card-glow p-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div><p className="text-xs text-slate-500">Customers</p><p className="text-white font-bold">{data.summary.customer_count}</p></div>
              <div><p className="text-xs text-slate-500">Total Consumption</p><p className="text-white font-bold">{fmt.m3(data.summary.total_consumption_m3)}</p></div>
              <div><p className="text-xs text-slate-500">Total Billed</p><p className="text-white font-bold">{fmt.usd(data.summary.total_billed)}</p></div>
              <div><p className="text-xs text-slate-500">Avg Rate</p><p className="text-white font-bold">${Number(data.summary.avg_rate_per_m3 || 0).toFixed(4)}/m³</p></div>
            </div>
          </div>
          <div className="card-glow overflow-hidden">
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead><tr><th>House #</th><th>Customer</th><th>Tariff</th><th>Zone</th><th>Invoices</th><th>Consumption</th><th>Total Billed</th><th>Rate/m³</th></tr></thead>
                <tbody>
                  {data.customers.map(c => (
                    <tr key={c.customer_id}>
                      <td className="font-mono text-xs text-slate-400">{c.house_number}</td>
                      <td>{c.full_name}</td>
                      <td className="capitalize text-slate-400 text-sm">{c.tariff_type}</td>
                      <td className="text-slate-400 text-sm">{c.zone_name || '—'}</td>
                      <td>{c.invoice_count}</td>
                      <td>{fmt.m3(c.total_consumption_m3)}</td>
                      <td>{fmt.usd(c.total_billed)}</td>
                      <td className="text-slate-400 text-sm">${Number(c.avg_rate_per_m3 || 0).toFixed(4)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Revenue Report ────────────────────────────────────────────────────────────

function RevenueReport() {
  const [from, setFrom] = useState('');
  const [to,   setTo]   = useState('');
  const [groupBy, setGroupBy] = useState('month');

  const { data, isFetching, refetch } = useQuery({
    queryKey: ['report-revenue', from, to, groupBy],
    queryFn: () => billingReportsAPI.revenue({ from: from || undefined, to: to || undefined, group_by: groupBy }).then(r => r.data),
    enabled: false,
  });

  return (
    <div className="space-y-4">
      <div className="card-glow p-4 flex flex-wrap gap-3 items-end">
        <div><label className="text-xs text-slate-400 block mb-1">From</label><input type="date" className="input" value={from} onChange={e => setFrom(e.target.value)} /></div>
        <div><label className="text-xs text-slate-400 block mb-1">To</label><input type="date" className="input" value={to} onChange={e => setTo(e.target.value)} /></div>
        <div>
          <label className="text-xs text-slate-400 block mb-1">Group By</label>
          <select className="input" value={groupBy} onChange={e => setGroupBy(e.target.value)}>
            <option value="day">Day</option>
            <option value="month">Month</option>
            <option value="year">Year</option>
          </select>
        </div>
        <button onClick={() => refetch()} disabled={isFetching} className="btn-primary flex items-center gap-2">
          {isFetching ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />} Generate
        </button>
      </div>
      {data && (
        <div className="space-y-4">
          <div className="card-glow p-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div><p className="text-xs text-slate-500">Total Revenue</p><p className="text-emerald-400 text-2xl font-bold">{fmt.usd(data.summary.total_revenue)}</p></div>
              <div><p className="text-xs text-slate-500">Total Invoiced</p><p className="text-white font-bold">{fmt.usd(data.summary.total_invoiced)}</p></div>
              <div><p className="text-xs text-slate-500">Collection Rate</p><p className="text-white font-bold">{fmt.pct(data.summary.collection_rate)}</p></div>
              <div><p className="text-xs text-slate-500">Periods</p><p className="text-white font-bold">{data.summary.period_count}</p></div>
            </div>
          </div>
          <div className="card-glow overflow-hidden">
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead><tr><th>Period</th><th>Invoices</th><th>Invoiced</th><th>Payments</th><th>Revenue</th><th>Customers</th><th>Collection %</th></tr></thead>
                <tbody>
                  {data.periods.map((p, i) => (
                    <tr key={i}>
                      <td className="font-mono text-sm">{String(p.period).slice(0, 10)}</td>
                      <td>{p.invoice_count}</td>
                      <td>{fmt.usd(p.invoiced)}</td>
                      <td>{p.payment_count}</td>
                      <td className="text-emerald-400">{fmt.usd(p.revenue)}</td>
                      <td>{p.customer_count}</td>
                      <td className={Number(p.collection_rate) >= 80 ? 'text-emerald-400' : Number(p.collection_rate) >= 50 ? 'text-amber-400' : 'text-red-400'}>
                        {fmt.pct(p.collection_rate)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function BillingReportsPage() {
  const [active, setActive] = useState('aging');

  return (
    <div className="p-4 lg:p-6 space-y-6 animate-fade-in">
      <div>
        <h1 className="text-2xl font-bold text-white font-display">Billing Reports</h1>
        <p className="text-slate-400 text-sm mt-0.5">Generate financial and billing reports</p>
      </div>

      {/* Report type selector */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        {REPORT_TYPES.map(rt => {
          const Icon = rt.icon;
          return (
            <button
              key={rt.id}
              onClick={() => setActive(rt.id)}
              className={`card-glow p-3 text-left transition-all ${active === rt.id ? 'border-primary-500/50 bg-primary-500/10' : 'hover:border-slate-600'}`}
            >
              <Icon className={`w-5 h-5 mb-2 ${active === rt.id ? 'text-primary-400' : 'text-slate-400'}`} />
              <p className={`text-sm font-medium ${active === rt.id ? 'text-white' : 'text-slate-300'}`}>{rt.label}</p>
              <p className="text-xs text-slate-500 mt-0.5 leading-tight">{rt.desc}</p>
            </button>
          );
        })}
      </div>

      <div>
        {active === 'customer-statement' && <CustomerStatementReport />}
        {active === 'zone'               && <ZoneBillingReport />}
        {active === 'aging'              && <AgingReport />}
        {active === 'unpaid'             && <UnpaidInvoicesReport />}
        {active === 'consumption'        && <ConsumptionReport />}
        {active === 'revenue'            && <RevenueReport />}
      </div>
    </div>
  );
}
