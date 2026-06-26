'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery } from '@tanstack/react-query';
import { tankerAPI, customersAPI } from '../../../../lib/api';
import { Loader2, ArrowLeft, Plus } from 'lucide-react';
import Link from 'next/link';
import toast from 'react-hot-toast';

export default function CreateTankerDeliveryPage() {
  const router = useRouter();
  const { data: customerData } = useQuery({
    queryKey: ['customers', 'list'],
    queryFn: () => customersAPI.list({ limit: 200 }).then(r => r.data)
  });
  const customers = customerData?.data || [];

  const [form, setForm] = useState({
    customer_id: '', delivery_reference: '', vehicle_number: '', driver_name: '', water_volume_liters: '', scheduled_date: '', delivery_address: '', status: 'scheduled', notes: ''
  });

  const mutation = useMutation({
    mutationFn: (payload) => tankerAPI.create(payload),
    onSuccess: () => { toast.success('Delivery scheduled'); router.push('/dashboard/tanker'); },
    onError: (err) => toast.error(err.response?.data?.error || 'Failed to schedule delivery')
  });

  return (
    <div className="p-4 lg:p-6 space-y-5 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white font-display">New Delivery</h1>
          <p className="text-slate-400 text-sm mt-0.5">Create a new tanker delivery for a customer.</p>
        </div>
        <Link href="/dashboard/tanker" className="btn-secondary text-sm flex items-center gap-2"><ArrowLeft className="w-4 h-4" /> Back</Link>
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
          <label className="block text-xs text-slate-400 mb-1">Delivery Reference</label>
          <input className="input" value={form.delivery_reference} onChange={e => setForm({ ...form, delivery_reference: e.target.value })} />
        </div>
        <div>
          <label className="block text-xs text-slate-400 mb-1">Vehicle Number</label>
          <input className="input" value={form.vehicle_number} onChange={e => setForm({ ...form, vehicle_number: e.target.value })} />
        </div>
        <div>
          <label className="block text-xs text-slate-400 mb-1">Driver Name</label>
          <input className="input" value={form.driver_name} onChange={e => setForm({ ...form, driver_name: e.target.value })} />
        </div>
        <div>
          <label className="block text-xs text-slate-400 mb-1">Volume (liters)</label>
          <input type="number" className="input" value={form.water_volume_liters} onChange={e => setForm({ ...form, water_volume_liters: e.target.value })} />
        </div>
        <div>
          <label className="block text-xs text-slate-400 mb-1">Schedule Date</label>
          <input type="date" className="input" value={form.scheduled_date} onChange={e => setForm({ ...form, scheduled_date: e.target.value })} />
        </div>
        <div className="lg:col-span-2">
          <label className="block text-xs text-slate-400 mb-1">Delivery Address</label>
          <input className="input" value={form.delivery_address} onChange={e => setForm({ ...form, delivery_address: e.target.value })} />
        </div>
        <div className="lg:col-span-2">
          <label className="block text-xs text-slate-400 mb-1">Notes</label>
          <textarea className="input min-h-[120px]" value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} />
        </div>
      </div>

      <div className="flex justify-end gap-3">
        <button onClick={() => router.push('/dashboard/tanker')} className="btn-secondary">Cancel</button>
        <button onClick={() => mutation.mutate({
          customer_id: form.customer_id,
          delivery_reference: form.delivery_reference,
          vehicle_number: form.vehicle_number,
          driver_name: form.driver_name,
          scheduled_at: form.scheduled_date,
          delivery_volume: Number(form.water_volume_liters),
          delivery_address: form.delivery_address,
          status: form.status,
          notes: form.notes
        })} disabled={mutation.isLoading || !form.customer_id || !form.delivery_reference || !form.vehicle_number || !form.driver_name || !form.water_volume_liters || !form.scheduled_date} className="btn-primary">
          {mutation.isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Schedule Delivery
        </button>
      </div>
    </div>
  );
}
