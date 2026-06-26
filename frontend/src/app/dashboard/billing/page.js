'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { billingAPI } from '../../../lib/api';
import Link from 'next/link';
import { FileText, Plus, ArrowRight, Search, Loader2 } from 'lucide-react';

export default function BillingPage() {
  const [search, setSearch] = useState('');
  const { data, isLoading } = useQuery({
    queryKey: ['billing', search],
    queryFn: () => billingAPI.list({ search, limit: 100 }).then(r => r.data)
  });

  const invoices = data?.data || [];

  return (
    <div className="p-4 lg:p-6 space-y-5 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white font-display">Billing</h1>
          <p className="text-slate-400 text-sm mt-0.5">Manage invoices and billing records</p>
        </div>
        <Link href="/dashboard/billing/create" className="btn-primary text-sm flex items-center gap-2"><Plus className="w-4 h-4" /> New Invoice</Link>
      </div>

      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
        <input className="input pl-9" placeholder="Search invoices..." value={search} onChange={e => setSearch(e.target.value)} />
      </div>

      <div className="card-glow overflow-hidden">
        {isLoading ? (
          <div className="flex items-center justify-center p-12"><Loader2 className="w-6 h-6 text-primary-400 animate-spin" /></div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Invoice</th>
                <th>Customer</th>
                <th>Amount</th>
                <th>Due Date</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {invoices.length === 0 ? (
                <tr><td colSpan={6} className="text-center py-12 text-slate-500">No invoices found</td></tr>
              ) : invoices.map(invoice => (
                <tr key={invoice.id}>
                  <td><span className="font-mono text-xs text-primary-400">{invoice.invoice_number}</span></td>
                  <td>{invoice.customer_name || 'Unknown'}</td>
                  <td className="font-medium text-white">${Number(invoice.total_amount).toFixed(2)}</td>
                  <td className="text-slate-400 text-sm">{new Date(invoice.due_date).toLocaleDateString()}</td>
                  <td><span className="text-xs px-2 py-1 rounded-full bg-slate-800 border border-slate-700">{invoice.status}</span></td>
                  <td><Link href={`/dashboard/billing/${invoice.id}`} className="text-primary-400 hover:text-primary-300"><ArrowRight className="w-4 h-4" /></Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
