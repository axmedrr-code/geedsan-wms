'use client';
import { useParams, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { billingAPI } from '../../../../lib/api';
import { ArrowLeft, FileText } from 'lucide-react';
import Link from 'next/link';

export default function BillingDetailPage() {
  const { id } = useParams();
  const router = useRouter();

  const { data, isLoading } = useQuery({
    queryKey: ['billing-detail', id],
    queryFn: () => billingAPI.get(id).then(r => r.data),
    enabled: !!id
  });

  const invoice = data?.invoice;
  const items = data?.items || [];

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64"><div className="w-8 h-8 border-2 border-primary-500/30 border-t-primary-500 rounded-full animate-spin" /></div>
    );
  }

  if (!invoice) {
    return <div className="p-6 text-slate-400">Invoice not found</div>;
  }

  return (
    <div className="p-4 lg:p-6 space-y-6 animate-fade-in">
      <div className="flex items-center justify-between gap-4">
        <button onClick={() => router.back()} className="btn-secondary text-sm flex items-center gap-2"><ArrowLeft className="w-4 h-4" /> Back</button>
        <div>
          <p className="text-slate-400 text-sm">Invoice details</p>
          <h1 className="text-2xl font-bold text-white font-display">{invoice.invoice_number}</h1>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className="card-glow p-5">
          <h2 className="text-sm uppercase tracking-[0.2em] text-slate-500 mb-4">Customer</h2>
          <p className="text-white font-semibold">{invoice.customer_name}</p>
          <p className="text-slate-400 text-sm">{invoice.customer_number}</p>
          <p className="mt-4 text-slate-400 text-sm">{invoice.customer_email}</p>
        </div>
        <div className="card-glow p-5">
          <div className="space-y-3">
            <div>
              <p className="text-slate-400 text-xs uppercase">Issue Date</p>
              <p className="text-white font-medium">{new Date(invoice.issue_date).toLocaleDateString()}</p>
            </div>
            <div>
              <p className="text-slate-400 text-xs uppercase">Due Date</p>
              <p className="text-white font-medium">{new Date(invoice.due_date).toLocaleDateString()}</p>
            </div>
          </div>
        </div>
        <div className="card-glow p-5">
          <div className="space-y-3">
            <div>
              <p className="text-slate-400 text-xs uppercase">Status</p>
              <p className="text-white font-medium capitalize">{invoice.status}</p>
            </div>
            <div>
              <p className="text-slate-400 text-xs uppercase">Total Amount</p>
              <p className="text-white font-bold text-lg">${Number(invoice.total_amount).toFixed(2)}</p>
            </div>
          </div>
        </div>
      </div>

      <div className="card-glow p-5">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold text-white">Line Items</h2>
            <p className="text-slate-500 text-sm">{items.length} item(s)</p>
          </div>
          <FileText className="w-5 h-5 text-primary-400" />
        </div>
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Description</th>
                <th>Qty</th>
                <th>Unit Price</th>
                <th>Line Total</th>
              </tr>
            </thead>
            <tbody>
              {items.map(item => (
                <tr key={item.id}>
                  <td>{item.description}</td>
                  <td>{item.quantity}</td>
                  <td>${Number(item.unit_price).toFixed(2)}</td>
                  <td>${(Number(item.unit_price) * Number(item.quantity)).toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
