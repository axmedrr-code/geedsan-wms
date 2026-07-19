'use client';
import { useState, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  CreditCard, DollarSign, TrendingUp, AlertCircle, Clock,
  CheckCircle, XCircle, Loader2, Search, RefreshCw, Plus,
  Receipt, ExternalLink, ChevronDown, Filter,
} from 'lucide-react';
import { format } from 'date-fns';
import toast from 'react-hot-toast';
import Link from 'next/link';
import { paymentsAPI, zonesAPI, customersAPI, billingAPI } from '../../../lib/api';
import { useAuthStore } from '../../../store/authStore';

// ── Stat Card ─────────────────────────────────────────────────────────────────

function StatCard({ icon: Icon, label, value, sub, color = 'primary' }) {
  const colors = {
    primary: 'from-primary-500/20 to-primary-600/5 border-primary-500/20 text-primary-400',
    green:   'from-emerald-500/20 to-emerald-600/5 border-emerald-500/20 text-emerald-400',
    amber:   'from-amber-500/20 to-amber-600/5 border-amber-500/20 text-amber-400',
    red:     'from-red-500/20 to-red-600/5 border-red-500/20 text-red-400',
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

// ── Status badge ──────────────────────────────────────────────────────────────

const STATUS_CLS = {
  completed:   'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  failed:      'bg-red-500/10 text-red-400 border-red-500/20',
  no_invoice:  'bg-amber-500/10 text-amber-400 border-amber-500/20',
  pending:     'bg-slate-700/50 text-slate-400 border-slate-700',
  processing:  'bg-blue-500/10 text-blue-400 border-blue-500/20',
  refunded:    'bg-purple-500/10 text-purple-400 border-purple-500/20',
};

const GATEWAY_LABEL = {
  sahal: 'Sahal',
  evc:   'EVC Plus',
  cash:  'Cash',
  bank:  'Bank',
  other: 'Other',
};

function StatusBadge({ status }) {
  return (
    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border capitalize ${STATUS_CLS[status] || STATUS_CLS.pending}`}>
      {status?.replace('_', ' ') || '—'}
    </span>
  );
}

const money = (v) => v == null ? '—' : `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ── Payment method config ─────────────────────────────────────────────────────

const PAYMENT_METHODS = [
  { value: 'cash',       label: 'Cash' },
  { value: 'sahal',      label: 'Sahal' },
  { value: 'evc',        label: 'EVC Plus' },
  { value: 'bank',       label: 'Bank Transfer' },
  { value: 'pos',        label: 'POS / Card' },
  { value: 'cheque',     label: 'Cheque' },
  { value: 'adjustment', label: 'Adjustment', adminOnly: true },
  { value: 'other',      label: 'Other' },
];

// Fields shown per payment method — stored in payment_meta JSONB
const METHOD_FIELDS = {
  cash: [
    { key: 'receipt_number', label: 'Receipt Number', placeholder: 'Cash receipt ref', mono: true },
    { key: 'cashier_name',   label: 'Cashier Name',   placeholder: 'Name of cashier' },
  ],
  sahal: [
    { key: 'phone_number',   label: 'Phone Number',   placeholder: '+252 61…',         type: 'tel' },
    { key: 'transaction_id', label: 'Transaction ID', placeholder: 'Sahal transaction ref', mono: true },
    { key: 'reference',      label: 'Reference No.',  placeholder: 'Additional reference',  mono: true },
  ],
  evc: [
    { key: 'phone_number',   label: 'Phone Number',   placeholder: '+252 61…',         type: 'tel' },
    { key: 'transaction_id', label: 'Transaction ID', placeholder: 'EVC Plus transaction ref', mono: true },
    { key: 'reference',      label: 'Reference No.',  placeholder: 'Additional reference',      mono: true },
  ],
  bank: [
    { key: 'bank_name',          label: 'Bank Name',         placeholder: 'e.g. Salaam Bank' },
    { key: 'transfer_reference', label: 'Transfer Reference', placeholder: 'Bank transfer ref', mono: true },
    { key: 'transfer_date',      label: 'Transfer Date',      type: 'date' },
  ],
  pos: [
    { key: 'terminal_id',   label: 'Terminal ID',   placeholder: 'POS terminal ID',    mono: true },
    { key: 'approval_code', label: 'Approval Code', placeholder: 'Card approval code', mono: true },
  ],
  cheque: [
    { key: 'cheque_number',  label: 'Cheque Number',  placeholder: 'e.g. CHQ-001', mono: true },
    { key: 'bank_name',      label: 'Bank Name',      placeholder: 'e.g. Salaam Bank' },
    { key: 'clearance_date', label: 'Clearance Date', type: 'date' },
  ],
  adjustment: [],
  other: [],
};

// ── Manual Payment Modal ──────────────────────────────────────────────────────

function ManualPaymentModal({ onClose }) {
  const qc = useQueryClient();
  const role = useAuthStore(s => s.user?.role);
  const canAdjust = ['admin', 'finance'].includes(role);

  const [form, setForm] = useState({ house_number: '', amount: '', gateway: 'cash', notes: '' });
  const [meta, setMeta] = useState({});
  const [errors, setErrors] = useState({});
  const [search, setSearch] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedCustomer, setSelectedCustomer] = useState(null);

  const visibleMethods = PAYMENT_METHODS.filter(m => !m.adminOnly || canAdjust);
  const methodFields = METHOD_FIELDS[form.gateway] || [];

  // Load all active customers once — filter in memory, never call API per keystroke
  const { data: allCustomers = [], isLoading: customersLoading } = useQuery({
    queryKey: ['customers-payment-search'],
    queryFn: () => customersAPI.list({ limit: 500, account_status: 'active' }).then(r => r.data?.data || []),
    staleTime: 5 * 60 * 1000,
  });

  // Fetch latest invoice only when a specific customer is selected
  const { data: latestInvoice } = useQuery({
    queryKey: ['latest-invoice-for-payment', selectedCustomer?.id],
    queryFn: () => billingAPI.list({ customer_id: selectedCustomer.id, limit: 1 }).then(r => r.data?.data?.[0] || null),
    enabled: !!selectedCustomer?.id,
    staleTime: 30000,
  });

  const suggestions = search.length >= 1
    ? allCustomers.filter(c => {
        const q = search.toLowerCase();
        return (
          c.house_number?.toLowerCase().includes(q) ||
          c.full_name?.toLowerCase().includes(q) ||
          c.phone?.toLowerCase().includes(q) ||
          c.primary_meter_number?.toLowerCase().includes(q)
        );
      }).slice(0, 8)
    : [];

  const handleSearchChange = (e) => {
    const val = e.target.value;
    setSearch(val);
    setForm(f => ({ ...f, house_number: val }));
    setSelectedCustomer(null);
    setShowSuggestions(true);
  };

  const handleSelect = (customer) => {
    setSelectedCustomer(customer);
    setSearch(customer.house_number);
    setForm(f => ({ ...f, house_number: customer.house_number }));
    setShowSuggestions(false);
  };

  const handleGatewayChange = (e) => {
    setForm(f => ({ ...f, gateway: e.target.value }));
    setMeta({});
  };

  const setMetaField = (k) => (e) => setMeta(m => ({ ...m, [k]: e.target.value }));

  const validate = () => {
    const e = {};
    if (!form.house_number.trim()) e.house_number = 'Required';
    if (!form.amount || Number(form.amount) <= 0) e.amount = 'Must be > 0';
    setErrors(e);
    return !Object.keys(e).length;
  };

  const mutation = useMutation({
    mutationFn: (d) => paymentsAPI.manualPayment(d),
    onSuccess: (res) => {
      const d = res.data;
      toast.success(`Payment recorded — Receipt: ${d.receipt_number || '—'}`);
      qc.invalidateQueries({ queryKey: ['payments'] });
      qc.invalidateQueries({ queryKey: ['payment-stats'] });
      onClose();
    },
    onError: (err) => toast.error(err.response?.data?.error || 'Payment failed'),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="card-glow w-full max-w-lg p-6 space-y-5 my-auto">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-white text-lg">Record Manual Payment</h3>
          <button onClick={onClose} className="btn-ghost p-1.5 text-slate-400 hover:text-white">✕</button>
        </div>

        <div className="grid grid-cols-2 gap-4">

          {/* ── Customer search ── */}
          <div className="col-span-2 relative">
            <label className="block text-xs text-slate-400 mb-1 font-medium">
              House Number / Customer <span className="text-red-400">*</span>
            </label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500 pointer-events-none" />
              <input
                className={`input pl-9 ${errors.house_number ? 'border-red-500/50' : ''}`}
                placeholder="Search by House No, Name, Phone or Meter..."
                value={search}
                onChange={handleSearchChange}
                onFocus={() => search.length >= 1 && setShowSuggestions(true)}
                onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
                autoComplete="off"
              />
              {customersLoading && (
                <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500 animate-spin" />
              )}
            </div>
            {errors.house_number && <p className="text-xs text-red-400 mt-1">{errors.house_number}</p>}

            {showSuggestions && suggestions.length > 0 && (
              <div className="absolute z-20 left-0 right-0 mt-1 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl overflow-hidden">
                {suggestions.map(c => (
                  <button
                    key={c.id}
                    type="button"
                    onMouseDown={() => handleSelect(c)}
                    className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-slate-800 text-left transition-colors border-b border-slate-800 last:border-0"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="font-mono text-sm font-bold text-white shrink-0">{c.house_number}</span>
                      <div className="min-w-0">
                        <p className="text-sm text-slate-300 truncate">{c.full_name}</p>
                        <p className="text-xs text-slate-500 truncate">
                          {c.zone_name && c.zone_name}
                          {c.primary_meter_number && ` · ${c.primary_meter_number}`}
                          {c.phone && ` · ${c.phone}`}
                        </p>
                      </div>
                    </div>
                    {Number(c.outstanding_balance) > 0 && (
                      <span className="text-xs font-mono font-semibold text-amber-400 shrink-0 ml-3">
                        {money(c.outstanding_balance)}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}

            {showSuggestions && search.length >= 1 && suggestions.length === 0 && !customersLoading && (
              <div className="absolute z-20 left-0 right-0 mt-1 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl px-4 py-3">
                <p className="text-sm text-slate-500">No customers found for &ldquo;{search}&rdquo;</p>
              </div>
            )}
          </div>

          {/* ── Selected customer info card ── */}
          {selectedCustomer && (
            <div className="col-span-2 bg-slate-800/60 border border-slate-700/50 rounded-xl p-3 space-y-1.5">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-white truncate">{selectedCustomer.full_name}</p>
                  <p className="text-xs text-slate-400 mt-0.5">
                    {selectedCustomer.zone_name && <span>{selectedCustomer.zone_name}</span>}
                    {selectedCustomer.primary_meter_number && (
                      <span className="ml-1">· Meter <span className="font-mono">{selectedCustomer.primary_meter_number}</span></span>
                    )}
                  </p>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-xs text-slate-400">Outstanding</p>
                  <p className={`text-sm font-mono font-bold ${Number(selectedCustomer.outstanding_balance) > 0 ? 'text-amber-400' : 'text-emerald-400'}`}>
                    {money(selectedCustomer.outstanding_balance)}
                  </p>
                </div>
              </div>
              {latestInvoice && (
                <div className="border-t border-slate-700/50 pt-1.5 flex items-center justify-between">
                  <p className="text-xs text-slate-500">
                    Latest invoice: <span className="font-mono text-slate-300">{latestInvoice.invoice_number}</span>
                    {latestInvoice.status && <span className="capitalize ml-1 text-slate-400">({latestInvoice.status})</span>}
                  </p>
                  <p className="text-xs font-mono text-slate-400">{money(latestInvoice.total_amount)}</p>
                </div>
              )}
            </div>
          )}

          {/* ── Amount ── */}
          <div>
            <label className="block text-xs text-slate-400 mb-1 font-medium">Amount (USD) <span className="text-red-400">*</span></label>
            <input
              className={`input ${errors.amount ? 'border-red-500/50' : ''}`}
              type="number" min="0.01" step="0.01" placeholder="0.00"
              value={form.amount}
              onChange={e => setForm(f => ({ ...f, amount: e.target.value }))}
            />
            {errors.amount && <p className="text-xs text-red-400 mt-1">{errors.amount}</p>}
          </div>

          {/* ── Payment method ── */}
          <div>
            <label className="block text-xs text-slate-400 mb-1 font-medium">Payment Method</label>
            <select className="select" value={form.gateway} onChange={handleGatewayChange}>
              {visibleMethods.map(m => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </div>

          {/* ── Conditional fields per method ── */}
          {methodFields.map((field, i) => (
            <div key={field.key} className={methodFields.length === 1 || (methodFields.length % 2 !== 0 && i === methodFields.length - 1) ? 'col-span-2' : ''}>
              <label className="block text-xs text-slate-400 mb-1 font-medium">{field.label}</label>
              <input
                className={`input${field.mono ? ' font-mono' : ''}`}
                type={field.type || 'text'}
                placeholder={field.placeholder || ''}
                value={meta[field.key] || ''}
                onChange={setMetaField(field.key)}
              />
            </div>
          ))}

          {/* ── Adjustment notice ── */}
          {form.gateway === 'adjustment' && (
            <div className="col-span-2 bg-amber-500/10 border border-amber-500/20 rounded-xl px-4 py-2.5">
              <p className="text-xs text-amber-400 font-medium">Adjustment — Admin / Finance only</p>
              <p className="text-xs text-amber-400/70 mt-0.5">Used for balance corrections, write-offs, or manual credits. Requires approval and full notes.</p>
            </div>
          )}

          {/* ── Notes (always shown) ── */}
          <div className="col-span-2">
            <label className="block text-xs text-slate-400 mb-1 font-medium">
              Notes {form.gateway === 'adjustment' && <span className="text-red-400">*</span>}
            </label>
            <textarea
              className="input min-h-[60px] resize-none"
              placeholder={form.gateway === 'adjustment' ? 'Reason for adjustment (required)' : 'Optional payment notes'}
              value={form.notes}
              onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
            />
          </div>
        </div>

        <div className="flex justify-end gap-3">
          <button onClick={onClose} className="btn-secondary">Cancel</button>
          <button
            onClick={() => {
              if (validate()) mutation.mutate({
                house_number: form.house_number,
                amount: Number(form.amount),
                gateway: form.gateway,
                notes: form.notes || null,
                phone_number: meta.phone_number || null,
                payment_meta: Object.keys(meta).length > 0 ? meta : undefined,
              });
            }}
            disabled={mutation.isPending}
            className="btn-primary"
          >
            {mutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
            Record Payment
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function PaymentsPage() {
  const [search, setSearch] = useState('');
  const [gateway, setGateway] = useState('');
  const [status, setStatus] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [page, setPage] = useState(1);
  const [showModal, setShowModal] = useState(false);
  const [statsKey, setStatsKey] = useState(0);
  const limit = 50;

  const { data: stats, isLoading: statsLoading } = useQuery({
    queryKey: ['payment-stats', statsKey],
    queryFn: () => paymentsAPI.stats().then(r => r.data),
    refetchInterval: 30000,
  });

  const { data: txns, isLoading: listLoading } = useQuery({
    queryKey: ['payments', search, gateway, status, dateFrom, dateTo, page],
    queryFn: () => paymentsAPI.list({
      search: search || undefined,
      gateway: gateway || undefined,
      status: status || undefined,
      date_from: dateFrom || undefined,
      date_to: dateTo || undefined,
      page, limit,
    }).then(r => r.data),
    refetchInterval: 15000,
  });

  const rows = txns?.data || [];
  const total = txns?.total || 0;
  const totalPages = Math.ceil(total / limit);

  const refresh = () => { setStatsKey(k => k + 1); };

  return (
    <div className="p-4 lg:p-6 space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white font-display">Payments</h1>
          <p className="text-slate-400 text-sm mt-0.5">Payment transactions, receipts and collection analytics</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={refresh} className="btn-secondary p-2" title="Refresh">
            <RefreshCw className="w-4 h-4" />
          </button>
          <button onClick={() => setShowModal(true)} className="btn-primary text-sm flex items-center gap-2">
            <Plus className="w-4 h-4" /> Record Payment
          </button>
        </div>
      </div>

      {/* Stats cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          icon={CreditCard}
          label="Today's Payments"
          value={statsLoading ? '…' : stats?.today_count}
          sub={statsLoading ? '' : `${money(stats?.today_revenue)} collected`}
          color="primary"
        />
        <StatCard
          icon={DollarSign}
          label="Monthly Revenue"
          value={statsLoading ? '…' : money(stats?.monthly_revenue)}
          sub={statsLoading ? '' : `${stats?.monthly_count || 0} transactions this month`}
          color="green"
        />
        <StatCard
          icon={AlertCircle}
          label="Outstanding Balance"
          value={statsLoading ? '…' : money(stats?.outstanding_balance)}
          sub="Across all active customers"
          color="amber"
        />
        <StatCard
          icon={TrendingUp}
          label="Collection Rate"
          value={statsLoading ? '…' : `${stats?.collection_rate || 0}%`}
          sub="Paid vs invoiced this month"
          color={stats?.collection_rate >= 80 ? 'green' : stats?.collection_rate >= 50 ? 'amber' : 'red'}
        />
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          icon={XCircle}
          label="Failed Today"
          value={statsLoading ? '…' : stats?.failed_today}
          sub="Rejected / unknown house #"
          color="red"
        />
        <StatCard
          icon={Clock}
          label="Pending"
          value={statsLoading ? '…' : stats?.pending_count}
          sub="No invoice matched"
          color="cyan"
        />
      </div>

      {/* Filters */}
      <div className="card-glow p-4">
        <div className="flex flex-wrap gap-3">
          <div className="flex items-center gap-2 flex-1 min-w-[200px]">
            <Search className="w-4 h-4 text-slate-500 flex-shrink-0" />
            <input
              className="input flex-1"
              placeholder="Search house #, receipt #, name, ref…"
              value={search}
              onChange={e => { setSearch(e.target.value); setPage(1); }}
            />
          </div>

          <select className="select w-36" value={gateway} onChange={e => { setGateway(e.target.value); setPage(1); }}>
            <option value="">All Gateways</option>
            <option value="sahal">Sahal</option>
            <option value="evc">EVC Plus</option>
            <option value="cash">Cash</option>
            <option value="bank">Bank</option>
          </select>

          <select className="select w-36" value={status} onChange={e => { setStatus(e.target.value); setPage(1); }}>
            <option value="">All Status</option>
            <option value="completed">Completed</option>
            <option value="failed">Failed</option>
            <option value="no_invoice">No Invoice</option>
            <option value="pending">Pending</option>
          </select>

          <input
            className="input w-36"
            type="date"
            value={dateFrom}
            onChange={e => { setDateFrom(e.target.value); setPage(1); }}
            title="From date"
          />
          <input
            className="input w-36"
            type="date"
            value={dateTo}
            onChange={e => { setDateTo(e.target.value); setPage(1); }}
            title="To date"
          />
        </div>
      </div>

      {/* Table */}
      <div className="card-glow overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-800">
                <th className="text-left px-4 py-3 text-xs text-slate-500 font-medium uppercase tracking-wider">Receipt #</th>
                <th className="text-left px-4 py-3 text-xs text-slate-500 font-medium uppercase tracking-wider">House No.</th>
                <th className="text-left px-4 py-3 text-xs text-slate-500 font-medium uppercase tracking-wider">Customer</th>
                <th className="text-left px-4 py-3 text-xs text-slate-500 font-medium uppercase tracking-wider">Gateway</th>
                <th className="text-right px-4 py-3 text-xs text-slate-500 font-medium uppercase tracking-wider">Amount</th>
                <th className="text-left px-4 py-3 text-xs text-slate-500 font-medium uppercase tracking-wider">Status</th>
                <th className="text-left px-4 py-3 text-xs text-slate-500 font-medium uppercase tracking-wider">Date</th>
                <th className="text-left px-4 py-3 text-xs text-slate-500 font-medium uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {listLoading ? (
                <tr><td colSpan={8} className="py-12 text-center text-slate-500">
                  <Loader2 className="w-6 h-6 animate-spin mx-auto" />
                </td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={8} className="py-12 text-center">
                  <CreditCard className="w-10 h-10 text-slate-700 mx-auto mb-3" />
                  <p className="text-slate-500 text-sm">No payment transactions found</p>
                </td></tr>
              ) : rows.map(tx => (
                <tr key={tx.id} className="hover:bg-slate-800/30 transition-colors">
                  <td className="px-4 py-3">
                    {tx.receipt_number
                      ? <span className="font-mono text-xs text-primary-400">{tx.receipt_number}</span>
                      : <span className="text-slate-600 text-xs">—</span>}
                  </td>
                  <td className="px-4 py-3">
                    <span className="font-mono text-sm font-semibold text-white">{tx.house_number}</span>
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-sm text-slate-300">{tx.full_name || <span className="text-slate-600">Unknown</span>}</span>
                    {tx.zone_code && <span className="ml-1.5 text-xs text-slate-500">{tx.zone_code}</span>}
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-xs font-medium text-slate-300">{GATEWAY_LABEL[tx.gateway] || tx.gateway}</span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <span className="font-mono font-semibold text-white">{money(tx.amount)}</span>
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={tx.status} />
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-xs text-slate-400">{format(new Date(tx.created_at), 'dd MMM yyyy HH:mm')}</span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1">
                      <Link href={`/dashboard/payments/${tx.id}`} className="btn-ghost p-1.5" title="View details">
                        <ExternalLink className="w-3.5 h-3.5" />
                      </Link>
                      {tx.receipt_number && (
                        <a
                          href={paymentsAPI.receiptUrl(tx.id)}
                          target="_blank"
                          rel="noreferrer"
                          className="btn-ghost p-1.5"
                          title="Print receipt"
                        >
                          <Receipt className="w-3.5 h-3.5" />
                        </a>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-slate-800">
            <p className="text-xs text-slate-500">{total} total transactions</p>
            <div className="flex gap-2">
              <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1} className="btn-secondary text-xs px-3 py-1.5 disabled:opacity-40">Prev</button>
              <span className="text-xs text-slate-400 flex items-center px-2">{page}/{totalPages}</span>
              <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages} className="btn-secondary text-xs px-3 py-1.5 disabled:opacity-40">Next</button>
            </div>
          </div>
        )}
      </div>

      {/* Manual payment modal */}
      {showModal && <ManualPaymentModal onClose={() => setShowModal(false)} />}
    </div>
  );
}
