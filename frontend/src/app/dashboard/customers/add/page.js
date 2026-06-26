'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation } from '@tanstack/react-query';
import { customersAPI } from '../../../../lib/api';
import { Plus, Loader2, ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import toast from 'react-hot-toast';

export default function AddCustomerPage() {
  const router = useRouter();
  const [form, setForm] = useState({ customer_number: '', full_name: '', email: '', phone: '', address: '', city: '', district: '', tariff_type: 'residential' });
  const mutation = useMutation({
    mutationFn: (payload) => customersAPI.create(payload),
    onSuccess: () => { toast.success('Customer created'); router.push('/dashboard/customers'); },
    onError: (err) => toast.error(err.response?.data?.error || 'Failed to create customer')
  });

  return (
    <div className="p-4 lg:p-6 space-y-5 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white font-display">Register Customer</h1>
          <p className="text-slate-400 text-sm mt-0.5">Add a new customer account for meter assignment</p>
        </div>
        <Link href="/dashboard/customers" className="btn-secondary text-sm flex items-center gap-2"><ArrowLeft className="w-4 h-4" /> Back</Link>
      </div>

      <div className="card-glow p-6 grid grid-cols-1 lg:grid-cols-2 gap-5">
        {[
          { label: 'Customer Number', key: 'customer_number' },
          { label: 'Full Name', key: 'full_name' },
          { label: 'Email', key: 'email' },
          { label: 'Phone', key: 'phone' },
          { label: 'City', key: 'city' },
          { label: 'District', key: 'district' }
        ].map(field => (
          <div key={field.key}>
            <label className="block text-xs text-slate-400 mb-1 font-medium">{field.label}</label>
            <input className="input" value={form[field.key]} onChange={e => setForm({ ...form, [field.key]: e.target.value })} />
          </div>
        ))}

        <div className="lg:col-span-2">
          <label className="block text-xs text-slate-400 mb-1 font-medium">Address</label>
          <textarea className="input min-h-[140px]" value={form.address} onChange={e => setForm({ ...form, address: e.target.value })} />
        </div>

        <div className="lg:col-span-2">
          <label className="block text-xs text-slate-400 mb-1 font-medium">Tariff Type</label>
          <select className="select" value={form.tariff_type} onChange={e => setForm({ ...form, tariff_type: e.target.value })}>
            <option value="residential">Residential</option>
            <option value="commercial">Commercial</option>
            <option value="industrial">Industrial</option>
            <option value="government">Government</option>
          </select>
        </div>
      </div>

      <div className="flex justify-end gap-3">
        <button onClick={() => router.push('/dashboard/customers')} className="btn-secondary">Cancel</button>
        <button onClick={() => mutation.mutate(form)} disabled={mutation.isLoading} className="btn-primary">
          {mutation.isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Create Customer
        </button>
      </div>
    </div>
  );
}
