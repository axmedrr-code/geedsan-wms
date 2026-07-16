'use client';
import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { billingAPI } from '../../../../lib/api';
import api from '../../../../lib/api';
import toast from 'react-hot-toast';
import {
  ArrowLeft, FileText, Download, CreditCard, XCircle, ExternalLink,
  RefreshCw, DollarSign, Calendar, User, CheckCircle, Clock, AlertCircle,
  Receipt, Zap, ChevronDown, ChevronUp
} from 'lucide-react';
import Link from 'next/link';

const STATUS_CONFIG = {
  pending:   { label: 'Pending',   color: 'text-amber-400',  bg: 'bg-amber-500/10 border-amber-500/30' },
  paid:      { label: 'Paid',      color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/30' },
  overdue:   { label: 'Overdue',   color: 'text-red-400',    bg: 'bg-red-500/10 border-red-500/30' },
  cancelled: { label: 'Cancelled', color: 'text-slate-400',  bg: 'bg-slate-500/10 border-slate-500/30' },
};

function StatusBadge({ status }) {
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.pending;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs font-medium ${cfg.bg} ${cfg.color}`}>
      {status === 'paid' && <CheckCircle className="w-3 h-3" />}
      {status === 'overdue' && <AlertCircle className="w-3 h-3" />}
      {status === 'pending' && <Clock className="w-3 h-3" />}
      {cfg.label}
    </span>
  );
}

function InfoRow({ label, value, mono }) {
  return (
    <div className="flex items-center justify-between py-2.5 border-b border-slate-700/50 last:border-0">
      <span className="text-slate-400 text-sm">{label}</span>
      <span className={`text-white text-sm font-medium ${mono ? 'font-mono' : ''}`}>{value ?? '—'}</span>
    </div>
  );
}

export default function BillingDetailPage() {
  const { id } = useParams();
  const router = useRouter();
  const qc = useQueryClient();
  const [showPaymentForm, setShowPaymentForm] = useState(false);
  const [paymentData, setPaymentData] = useState({ amount: '', method: 'cash', reference: '', note: '' });
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [showPayments, setShowPayments] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['billing-detail', id],
    queryFn: () => billingAPI.get(id).then(r => r.data),
    enabled: !!id,
  });

  const { data: payments } = useQuery({
    queryKey: ['billing-payments', id],
    queryFn: () => api.get(`/billing/${id}/payments`).then(r => r.data).catch(() => []),
    enabled: !!id,
  });

  const payMutation = useMutation({
    mutationFn: (d) => billingAPI.recordPayment(id, d),
    onSuccess: () => {
      toast.success('Payment recorded');
      qc.invalidateQueries({ queryKey: ['billing-detail', id] });
      setShowPaymentForm(false);
      setPaymentData({ amount: '', method: 'cash', reference: '', note: '' });
    },
    onError: (e) => toast.error(e.response?.data?.error || 'Failed to record payment'),
  });

  const cancelMutation = useMutation({
    mutationFn: () => billingAPI.update(id, { status: 'cancelled' }),
    onSuccess: () => {
      toast.success('Invoice cancelled');
      qc.invalidateQueries({ queryKey: ['billing-detail', id] });
      setShowCancelConfirm(false);
    },
    onError: (e) => toast.error(e.response?.data?.error || 'Failed to cancel invoice'),
  });

  const syncMutation = useMutation({
    mutationFn: () => api.post(`/odoo/sync/invoice/${id}`),
    onSuccess: (r) => toast.success(`Synced to Odoo (id: ${r.data.odooId})`),
    onError: (e) => toast.error(e.response?.data?.error || 'Sync failed'),
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-2 border-primary-500/30 border-t-primary-500 rounded-full animate-spin" />
      </div>
    );
  }

  const invoice = data?.invoice;
  const items = data?.items || [];

  if (!invoice) {
    return (
      <div className="p-6 flex flex-col items-center justify-center h-64 gap-4">
        <FileText className="w-12 h-12 text-slate-600" />
        <p className="text-slate-400">Invoice not found</p>
        <button onClick={() => router.back()} className="btn-secondary text-sm">Go Back</button>
      </div>
    );
  }

  const totalPaid = Number(invoice.total_paid || 0);
  const totalAmount = Number(invoice.total_amount || 0);
  const balance = totalAmount - totalPaid;
  const isOverdue = invoice.status === 'overdue';
  const isPaid = invoice.status === 'paid';
  const isCancelled = invoice.status === 'cancelled';

  // Parse billing period from item description if available
  const periodDesc = items[0]?.description || '';
  const periodMatch = periodDesc.match(/(\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2})/);
  const periodStart = periodMatch?.[1];
  const periodEnd = periodMatch?.[2];

  const pdfUrl = `/reports/invoice-${invoice.invoice_number}.pdf`;
  const ODOO_BASE = process.env.NEXT_PUBLIC_ODOO_URL || 'http://localhost:8069';

  return (
    <div className="p-4 lg:p-6 space-y-6 animate-fade-in">

      {/* ── Header ───────────────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <button onClick={() => router.back()} className="btn-secondary p-2"><ArrowLeft className="w-4 h-4" /></button>
          <div>
            <p className="text-slate-400 text-xs uppercase tracking-wider">Invoice</p>
            <h1 className="text-2xl font-bold text-white font-display">{invoice.invoice_number}</h1>
          </div>
          <StatusBadge status={invoice.status} />
        </div>

        <div className="flex flex-wrap gap-2">
          {/* PDF */}
          <a href={`/api${pdfUrl}`} target="_blank" rel="noreferrer"
             className="btn-secondary text-sm flex items-center gap-1.5">
            <FileText className="w-4 h-4" /> View PDF
          </a>
          <a href={`/api${pdfUrl}`} download={`${invoice.invoice_number}.pdf`}
             className="btn-secondary text-sm flex items-center gap-1.5">
            <Download className="w-4 h-4" /> Download
          </a>

          {/* Register Payment */}
          {!isPaid && !isCancelled && (
            <button onClick={() => setShowPaymentForm(v => !v)}
                    className="btn-secondary text-sm flex items-center gap-1.5 text-emerald-400 border-emerald-500/30">
              <CreditCard className="w-4 h-4" /> Register Payment
            </button>
          )}

          {/* Odoo Sync */}
          <button onClick={() => syncMutation.mutate()} disabled={syncMutation.isPending}
                  className="btn-secondary text-sm flex items-center gap-1.5">
            <RefreshCw className={`w-4 h-4 ${syncMutation.isPending ? 'animate-spin' : ''}`} />
            Sync Odoo
          </button>

          {/* Open in Odoo */}
          {invoice.odoo_id && (
            <a href={`${ODOO_BASE}/odoo/accounting/${invoice.odoo_id}`} target="_blank" rel="noreferrer"
               className="btn-secondary text-sm flex items-center gap-1.5">
              <ExternalLink className="w-4 h-4" /> Open in Odoo
            </a>
          )}

          {/* Cancel */}
          {!isPaid && !isCancelled && (
            <button onClick={() => setShowCancelConfirm(true)}
                    className="btn-secondary text-sm flex items-center gap-1.5 text-red-400 border-red-500/30">
              <XCircle className="w-4 h-4" /> Cancel
            </button>
          )}
        </div>
      </div>

      {/* ── Payment Form (collapsible) ───────────────────────────────────── */}
      {showPaymentForm && (
        <div className="card-glow p-5 border-emerald-500/30">
          <h3 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
            <CreditCard className="w-4 h-4 text-emerald-400" /> Register Payment
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <div>
              <label className="block text-xs text-slate-400 mb-1">Amount ($)</label>
              <input type="number" step="0.01" value={paymentData.amount}
                     onChange={e => setPaymentData(p => ({ ...p, amount: e.target.value }))}
                     placeholder={balance.toFixed(2)}
                     className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm" />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Method</label>
              <select value={paymentData.method}
                      onChange={e => setPaymentData(p => ({ ...p, method: e.target.value }))}
                      className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm">
                <option value="cash">Cash</option>
                <option value="bank_transfer">Bank Transfer</option>
                <option value="mobile_money">Mobile Money</option>
                <option value="cheque">Cheque</option>
                <option value="card">Card</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Reference</label>
              <input type="text" value={paymentData.reference}
                     onChange={e => setPaymentData(p => ({ ...p, reference: e.target.value }))}
                     placeholder="Receipt / Tx ID"
                     className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm" />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Note</label>
              <input type="text" value={paymentData.note}
                     onChange={e => setPaymentData(p => ({ ...p, note: e.target.value }))}
                     placeholder="Optional note"
                     className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm" />
            </div>
          </div>
          <div className="flex gap-2 mt-4">
            <button onClick={() => payMutation.mutate({ amount: Number(paymentData.amount) || balance, method: paymentData.method, reference: paymentData.reference, note: paymentData.note })}
                    disabled={payMutation.isPending}
                    className="btn-primary text-sm flex items-center gap-1.5">
              {payMutation.isPending ? <RefreshCw className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
              Confirm Payment
            </button>
            <button onClick={() => setShowPaymentForm(false)} className="btn-secondary text-sm">Cancel</button>
          </div>
        </div>
      )}

      {/* ── Cancel Confirm ───────────────────────────────────────────────── */}
      {showCancelConfirm && (
        <div className="card-glow p-5 border-red-500/30 bg-red-500/5">
          <p className="text-white font-medium mb-2">Cancel this invoice?</p>
          <p className="text-slate-400 text-sm mb-4">This action cannot be undone. The invoice will be marked as cancelled.</p>
          <div className="flex gap-2">
            <button onClick={() => cancelMutation.mutate()} disabled={cancelMutation.isPending}
                    className="btn-secondary text-sm text-red-400 border-red-500/30">
              {cancelMutation.isPending ? 'Cancelling…' : 'Yes, Cancel Invoice'}
            </button>
            <button onClick={() => setShowCancelConfirm(false)} className="btn-secondary text-sm">Keep Invoice</button>
          </div>
        </div>
      )}

      {/* ── Balance Banner ───────────────────────────────────────────────── */}
      <div className={`rounded-xl border p-5 flex items-center justify-between ${isPaid ? 'bg-emerald-500/10 border-emerald-500/30' : isCancelled ? 'bg-slate-500/10 border-slate-600/30' : isOverdue ? 'bg-red-500/10 border-red-500/30' : 'bg-amber-500/10 border-amber-500/30'}`}>
        <div>
          <p className={`text-sm font-medium ${isPaid ? 'text-emerald-400' : isCancelled ? 'text-slate-400' : isOverdue ? 'text-red-400' : 'text-amber-400'}`}>
            {isPaid ? 'Fully Paid' : isCancelled ? 'Invoice Cancelled' : isOverdue ? 'Payment Overdue' : 'Payment Pending'}
          </p>
          <p className="text-white text-3xl font-bold font-display mt-1">
            ${isPaid ? '0.00' : balance.toFixed(2)} <span className="text-slate-400 text-base font-normal">outstanding</span>
          </p>
        </div>
        <div className="text-right">
          <p className="text-slate-400 text-xs">Total Amount</p>
          <p className="text-white text-lg font-semibold">${totalAmount.toFixed(2)}</p>
          <p className="text-slate-400 text-xs mt-1">Paid: ${totalPaid.toFixed(2)}</p>
        </div>
      </div>

      {/* ── 3-column info grid ───────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">

        {/* Customer */}
        <div className="card-glow p-5">
          <div className="flex items-center gap-2 mb-4">
            <User className="w-4 h-4 text-primary-400" />
            <h2 className="text-sm font-semibold text-white">Customer</h2>
          </div>
          <p className="text-white font-semibold text-lg">{invoice.customer_name}</p>
          <p className="text-slate-400 text-sm">{invoice.customer_number || 'No account number'}</p>
          {invoice.customer_email && <p className="text-slate-400 text-sm mt-2">{invoice.customer_email}</p>}
          {invoice.customer_id && (
            <Link href={`/dashboard/customers/${invoice.customer_id}`}
                  className="inline-flex items-center gap-1 text-primary-400 text-xs mt-3 hover:underline">
              View Customer Profile <ExternalLink className="w-3 h-3" />
            </Link>
          )}
        </div>

        {/* Dates & Period */}
        <div className="card-glow p-5">
          <div className="flex items-center gap-2 mb-4">
            <Calendar className="w-4 h-4 text-primary-400" />
            <h2 className="text-sm font-semibold text-white">Billing Details</h2>
          </div>
          <InfoRow label="Issue Date" value={invoice.issue_date ? new Date(invoice.issue_date).toLocaleDateString() : '—'} />
          <InfoRow label="Due Date"   value={invoice.due_date   ? new Date(invoice.due_date).toLocaleDateString()   : '—'} />
          {periodStart && <InfoRow label="Period Start" value={periodStart} />}
          {periodEnd   && <InfoRow label="Period End"   value={periodEnd}   />}
          <InfoRow label="Tariff Type" value={invoice.tariff_type ? invoice.tariff_type.charAt(0).toUpperCase() + invoice.tariff_type.slice(1) : '—'} />
        </div>

        {/* Financial Summary */}
        <div className="card-glow p-5">
          <div className="flex items-center gap-2 mb-4">
            <DollarSign className="w-4 h-4 text-primary-400" />
            <h2 className="text-sm font-semibold text-white">Financial Summary</h2>
          </div>
          <InfoRow label="Subtotal"   value={`$${totalAmount.toFixed(2)}`} />
          <InfoRow label="Tax (0%)"   value="$0.00" />
          <InfoRow label="Discount"   value="$0.00" />
          <div className="flex items-center justify-between pt-3 border-t border-slate-700/50 mt-1">
            <span className="text-white font-semibold">Total</span>
            <span className="text-white font-bold text-lg">${totalAmount.toFixed(2)}</span>
          </div>
          <div className="flex items-center justify-between mt-2">
            <span className="text-slate-400 text-sm">Total Paid</span>
            <span className="text-emerald-400 font-medium">${totalPaid.toFixed(2)}</span>
          </div>
          <div className="flex items-center justify-between mt-1">
            <span className="text-slate-400 text-sm">Balance Due</span>
            <span className={`font-bold ${balance > 0 ? 'text-amber-400' : 'text-emerald-400'}`}>${balance.toFixed(2)}</span>
          </div>
        </div>
      </div>

      {/* ── Line Items ───────────────────────────────────────────────────── */}
      <div className="card-glow p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Receipt className="w-4 h-4 text-primary-400" />
            <h2 className="text-sm font-semibold text-white">Line Items</h2>
            <span className="text-xs text-slate-500 bg-slate-700/50 px-2 py-0.5 rounded-full">{items.length}</span>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Description</th>
                <th className="text-right">Qty</th>
                <th className="text-right">Unit Price</th>
                <th className="text-right">Line Total</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 ? (
                <tr><td colSpan={4} className="text-center text-slate-500 py-8">No line items</td></tr>
              ) : items.map(item => (
                <tr key={item.id}>
                  <td>{item.description}</td>
                  <td className="text-right">{Number(item.quantity).toFixed(2)}</td>
                  <td className="text-right">${Number(item.unit_price).toFixed(2)}</td>
                  <td className="text-right font-medium">${(Number(item.quantity) * Number(item.unit_price)).toFixed(2)}</td>
                </tr>
              ))}
              <tr className="font-semibold bg-slate-700/30">
                <td colSpan={3} className="text-right text-white">Total</td>
                <td className="text-right text-white">${totalAmount.toFixed(2)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Payment History ──────────────────────────────────────────────── */}
      <div className="card-glow p-5">
        <button onClick={() => setShowPayments(v => !v)}
                className="w-full flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Zap className="w-4 h-4 text-primary-400" />
            <h2 className="text-sm font-semibold text-white">Payment History</h2>
            <span className="text-xs text-slate-500 bg-slate-700/50 px-2 py-0.5 rounded-full">
              ${totalPaid.toFixed(2)} collected
            </span>
          </div>
          {showPayments ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
        </button>
        {showPayments && (
          <div className="mt-4 overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Amount</th>
                  <th>Method</th>
                  <th>Reference</th>
                  <th>Odoo Sync</th>
                </tr>
              </thead>
              <tbody>
                {!payments || payments.length === 0 ? (
                  <tr><td colSpan={5} className="text-center text-slate-500 py-6">No payments recorded</td></tr>
                ) : payments.map(p => (
                  <tr key={p.id}>
                    <td>{p.payment_date ? new Date(p.payment_date).toLocaleDateString() : '—'}</td>
                    <td className="text-emerald-400 font-medium">${Number(p.amount).toFixed(2)}</td>
                    <td className="capitalize">{p.method}</td>
                    <td className="font-mono text-xs">{p.reference || '—'}</td>
                    <td>
                      {p.odoo_id
                        ? <span className="text-emerald-400 text-xs">✓ {p.odoo_id}</span>
                        : <span className="text-slate-500 text-xs">Not synced</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Metadata ─────────────────────────────────────────────────────── */}
      <div className="card-glow p-5">
        <h2 className="text-xs uppercase tracking-wider text-slate-500 mb-3">Metadata</h2>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 text-sm">
          <div>
            <p className="text-slate-400 text-xs">Invoice ID</p>
            <p className="text-white font-mono text-xs mt-0.5">{invoice.id}</p>
          </div>
          <div>
            <p className="text-slate-400 text-xs">Odoo ID</p>
            <p className="text-white font-mono text-xs mt-0.5">{invoice.odoo_id || 'Not synced'}</p>
          </div>
          <div>
            <p className="text-slate-400 text-xs">Created By</p>
            <p className="text-white text-xs mt-0.5">{invoice.created_by_name || 'System'}</p>
          </div>
          <div>
            <p className="text-slate-400 text-xs">Notes</p>
            <p className="text-white text-xs mt-0.5">{invoice.notes || '—'}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
