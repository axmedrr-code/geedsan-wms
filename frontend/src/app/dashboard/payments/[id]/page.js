'use client';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft, Receipt, ExternalLink, CheckCircle, XCircle,
  Clock, Loader2, CreditCard, User, Hash, Calendar,
} from 'lucide-react';
import Link from 'next/link';
import { format } from 'date-fns';
import { paymentsAPI } from '../../../../lib/api';

const money = (v) => v == null ? '—' : `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const STATUS_CLS = {
  completed:  'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  failed:     'bg-red-500/10 text-red-400 border-red-500/20',
  no_invoice: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  pending:    'bg-slate-700/50 text-slate-400 border-slate-700',
  processing: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  refunded:   'bg-purple-500/10 text-purple-400 border-purple-500/20',
};

const STATUS_ICON = {
  completed:  CheckCircle,
  failed:     XCircle,
  no_invoice: Clock,
};

const GATEWAY_LABEL = { sahal: 'Sahal', evc: 'EVC Plus', cash: 'Cash', bank: 'Bank Transfer', other: 'Other' };

function InfoRow({ label, value, mono = false }) {
  return (
    <div className="flex items-start justify-between gap-3 py-2.5 border-b border-slate-800/60 last:border-0">
      <span className="text-xs text-slate-500 flex-shrink-0 pt-0.5">{label}</span>
      <span className={`text-sm text-right break-all ${mono ? 'font-mono text-primary-400' : 'text-slate-300'}`}>{value ?? '—'}</span>
    </div>
  );
}

export default function PaymentDetailPage() {
  const { id } = useParams();

  const { data: tx, isLoading } = useQuery({
    queryKey: ['payment-detail', id],
    queryFn: () => paymentsAPI.receipt(id).then(r => r.data),
    enabled: !!id,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-20">
        <Loader2 className="w-8 h-8 animate-spin text-primary-400" />
      </div>
    );
  }

  if (!tx) {
    return (
      <div className="p-6">
        <p className="text-slate-400">Transaction not found.</p>
        <Link href="/dashboard/payments" className="btn-secondary mt-4 inline-flex items-center gap-2">
          <ArrowLeft className="w-4 h-4" /> Back to Payments
        </Link>
      </div>
    );
  }

  const StatusIcon = STATUS_ICON[tx.status] || Clock;
  const appliedInvoices = Array.isArray(tx.applied_invoices) ? tx.applied_invoices : [];
  const date = new Date(tx.processed_at || tx.created_at);

  return (
    <div className="p-4 lg:p-6 space-y-5 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href="/dashboard/payments" className="btn-secondary p-2">
            <ArrowLeft className="w-4 h-4" />
          </Link>
          <div>
            <h1 className="text-xl font-bold text-white font-display">Payment Details</h1>
            <p className="text-slate-400 text-sm mt-0.5">
              {tx.receipt_number
                ? <span className="font-mono text-primary-400">{tx.receipt_number}</span>
                : <span className="font-mono text-slate-500">{tx.transaction_ref}</span>}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {tx.receipt_number && (
            <a
              href={paymentsAPI.receiptUrl(tx.id)}
              target="_blank"
              rel="noreferrer"
              className="btn-secondary text-sm flex items-center gap-2"
            >
              <Receipt className="w-4 h-4" /> Print Receipt
            </a>
          )}
        </div>
      </div>

      {/* Status banner */}
      <div className={`flex items-center gap-3 p-4 rounded-xl border ${STATUS_CLS[tx.status] || STATUS_CLS.pending}`}>
        <StatusIcon className="w-5 h-5 flex-shrink-0" />
        <div>
          <p className="font-semibold capitalize">{tx.status?.replace('_', ' ')}</p>
          {tx.status === 'completed' && (
            <p className="text-xs opacity-80">
              {money(tx.amount)} received on {format(date, 'dd MMM yyyy')} at {format(date, 'HH:mm:ss')}
            </p>
          )}
          {tx.status === 'no_invoice' && (
            <p className="text-xs opacity-80">Payment received but no pending invoice found for {tx.house_number}</p>
          )}
          {tx.status === 'failed' && (
            <p className="text-xs opacity-80">House number {tx.house_number} not found in the system</p>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* Transaction details */}
        <div className="card-glow p-5">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-4 flex items-center gap-2">
            <CreditCard className="w-4 h-4" /> Transaction
          </p>
          <InfoRow label="Transaction Ref" value={tx.transaction_ref} mono />
          <InfoRow label="Receipt #" value={tx.receipt_number} mono />
          <InfoRow label="Gateway" value={GATEWAY_LABEL[tx.gateway] || tx.gateway} />
          <InfoRow label="Amount" value={money(tx.amount)} />
          <InfoRow label="Currency" value={tx.currency} />
          <InfoRow label="Gateway Status" value={tx.gateway_status} />
          <InfoRow label="Payer Phone" value={tx.phone_number} />
          <InfoRow label="Processed At" value={tx.processed_at ? format(new Date(tx.processed_at), 'dd MMM yyyy HH:mm:ss') : null} />
          <InfoRow label="Created At" value={format(new Date(tx.created_at), 'dd MMM yyyy HH:mm:ss')} />
          {Number(tx.remaining_credit) > 0 && (
            <InfoRow label="Unmatched Credit" value={money(tx.remaining_credit)} />
          )}
        </div>

        {/* Customer details */}
        <div className="card-glow p-5">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-4 flex items-center gap-2">
            <User className="w-4 h-4" /> Customer
          </p>
          <InfoRow label="House Number" value={tx.house_number} mono />
          <InfoRow label="Full Name" value={tx.full_name} />
          {tx.zone_code && <InfoRow label="Zone" value={`${tx.zone_code} — ${tx.zone_name || ''}`} />}
          <InfoRow label="Phone" value={tx.customer_phone} />
          <InfoRow label="Email" value={tx.customer_email} />
          <InfoRow label="Address" value={tx.customer_address} />
          {tx.cashier_name && <InfoRow label="Recorded By" value={tx.cashier_name} />}
          {tx.ip_address && <InfoRow label="IP Address" value={tx.ip_address} mono />}
          {tx.notes && <InfoRow label="Notes" value={tx.notes} />}
        </div>
      </div>

      {/* Applied invoices */}
      {appliedInvoices.length > 0 && (
        <div className="card-glow p-5">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-4 flex items-center gap-2">
            <Hash className="w-4 h-4" /> Invoices Settled ({appliedInvoices.length})
          </p>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-800">
                  <th className="text-left pb-2 text-xs text-slate-500">Invoice #</th>
                  <th className="text-right pb-2 text-xs text-slate-500">Amount Applied</th>
                  <th className="text-left pb-2 text-xs text-slate-500 pl-4">Status After</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/40">
                {appliedInvoices.map((inv, i) => (
                  <tr key={i}>
                    <td className="py-2 font-mono text-sm text-slate-300">{inv.invoice_number}</td>
                    <td className="py-2 text-right font-mono font-semibold text-white">{money(inv.amount)}</td>
                    <td className="py-2 pl-4">
                      <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${
                        inv.status === 'paid'
                          ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                          : 'bg-amber-500/10 text-amber-400 border-amber-500/20'
                      }`}>
                        {inv.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* SMS receipt text */}
      {tx.receipt_text && (
        <div className="card-glow p-5">
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">SMS / WhatsApp Receipt</p>
            <button
              onClick={() => navigator.clipboard?.writeText(tx.receipt_text).then(() => {})}
              className="btn-secondary text-xs px-2 py-1"
            >
              Copy
            </button>
          </div>
          <pre className="text-xs text-slate-300 font-mono bg-slate-900/60 rounded-lg p-3 whitespace-pre-wrap overflow-x-auto">
            {tx.receipt_text}
          </pre>
        </div>
      )}
    </div>
  );
}
