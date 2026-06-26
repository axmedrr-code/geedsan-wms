'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery } from '@tanstack/react-query';
import { billingAPI, customersAPI } from '../../../../lib/api';
import { Loader2, ArrowLeft, Plus } from 'lucide-react';
import Link from 'next/link';
import toast from 'react-hot-toast';

export default function CreateBillingPage() {
  const router = useRouter();
  const { data: customerData } = useQuery({
    queryKey: ['customers', 'list'],
    queryFn: () => customersAPI.list({ limit: 200 }).then(r => r.data)
  });
  const customers = customerData?.data || [];

  const [form, setForm] = useState({
    customer_id: '', invoice_number: '', issue_date: new Date().toISOString().slice(0, 10), due_date: '', total_amount: '', status: 'pending', notes: ''
  });

  const mutation = useMutation({
    mutationFn: (payload) => billingAPI.create(payload),
    onSuccess: () => { toast.success('Invoice created'); router.push('/dashboard/billing'); },
    onError: (err) => toast.error(err.response?.data?.error || 'Failed to create invoice')
  });

  return (
    <div className="p-4 lg:p-6 space-y-5 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white font-display">New Invoice</h1>
          <p className="text-slate-400 text-sm mt-0.5">Create a new billing invoice for a customer.</p>
        </div>
        <Link href="/dashboard/billing" className="btn-secondary text-sm flex items-center gap-2"><ArrowLeft className="w-4 h-4" /> Back</Link>
      </div>

      <div className="card-glow p-6 grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div>
          <label className="block text-xs text-slate-400 mb-1">Customer</label>
          <select className="select" value={form.customer_id} onChange={e => setForm({ ...form, customer_id: e.target.value })}>
            <option value="">Select a customer</option>
            {customers.map(customer => (
              <option key={customer.id} value={customer.id}>{customer.customer_number} — {customer.full_name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-slate-400 mb-1">Invoice Number</label>
          <input className="input" value={form.invoice_number} onChange={e => setForm({ ...form, invoice_number: e.target.value })} />
        </div>
        <div>
          <label className="block text-xs text-slate-400 mb-1">Issue Date</label>
          <input type="date" className="input" value={form.issue_date} onChange={e => setForm({ ...form, issue_date: e.target.value })} />
        </div>
        <div>
          <label className="block text-xs text-slate-400 mb-1">Due Date</label>
          <input type="date" className="input" value={form.due_date} onChange={e => setForm({ ...form, due_date: e.target.value })} />
        </div>
        <div>
          <label className="block text-xs text-slate-400 mb-1">Amount</label>
          <input type="number" className="input" value={form.total_amount} onChange={e => setForm({ ...form, total_amount: e.target.value })} />
        </div>
        <div className="lg:col-span-2">
          <label className="block text-xs text-slate-400 mb-1">Notes</label>
          <textarea className="input min-h-[120px]" value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} />
        </div>
      </div>

      <div className="flex justify-end gap-3">
        <button onClick={() => router.push('/dashboard/billing')} className="btn-secondary">Cancel</button>
        <button onClick={() => mutation.mutate({
          ...form,
          issue_date: form.issue_date || new Date().toISOString().slice(0, 10),
          total_amount: Number(form.total_amount),
          line_items: [{ description: 'Meter service', quantity: 1, unit_price: Number(form.total_amount) }]
        })} disabled={mutation.isLoading || !form.customer_id || !form.invoice_number || !form.due_date || !form.total_amount} className="btn-primary">
          {mutation.isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Save Invoice
        </button>
      </div>
    </div>
  );
}
