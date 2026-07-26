'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { metersAPI, customersAPI, waterTypesAPI } from '../../../../lib/api';
import { Plus, Loader2, ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import toast from 'react-hot-toast';

export default function AddMeterPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    device_eui: '', meter_number: '', customer_id: '', application_id: '', latitude: '', longitude: '', installation_address: '', firmware_version: '', notes: '', water_type_id: '', reading_mode: 'automatic'
  });

  const { data: customers } = useQuery({ queryKey: ['customers', 'combo'], queryFn: () => customersAPI.list({ limit: 200 }).then(r => r.data.data) });
  const { data: waterTypes } = useQuery({ queryKey: ['water-types', 'combo'], queryFn: () => waterTypesAPI.list({ active: true }).then(r => r.data) });

  // A customer has exactly one water type (enforced server-side by a DB
  // trigger) — once they already have one established, lock this field to
  // it instead of letting the user pick something that will just get
  // rejected on submit.
  const selectedCustomer = customers?.find(c => c.id === form.customer_id);
  const lockedWaterTypeId = selectedCustomer?.water_type_id || '';

  const handleCustomerChange = (customerId) => {
    const cust = customers?.find(c => c.id === customerId);
    setForm(f => ({ ...f, customer_id: customerId, water_type_id: cust?.water_type_id || f.water_type_id }));
  };

  const mutation = useMutation({
    mutationFn: (payload) => metersAPI.create(payload),
    onSuccess: () => {
      toast.success('Meter created');
      queryClient.invalidateQueries(['meters']);
      router.push('/dashboard/meters');
    },
    onError: (err) => toast.error(err.response?.data?.error || 'Failed to create meter')
  });

  return (
    <div className="p-4 lg:p-6 space-y-5 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white font-display">Add Meter</h1>
          <p className="text-slate-400 text-sm mt-0.5">Register a new smart water meter device</p>
        </div>
        <Link href="/dashboard/meters" className="btn-secondary text-sm flex items-center gap-2"><ArrowLeft className="w-4 h-4" /> Back</Link>
      </div>

      <div className="card-glow p-6 grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div>
          <label className="block text-xs text-slate-400 mb-1 font-medium">Reading Mode</label>
          <select className="select" value={form.reading_mode} onChange={e => setForm({ ...form, reading_mode: e.target.value })}>
            <option value="automatic">Automatic (Smart/LoRaWAN)</option>
            <option value="manual">Manual (Legacy — no radio)</option>
          </select>
        </div>
        <div>
          <label className="block text-xs text-slate-400 mb-1 font-medium">Water Type</label>
          <select
            className="select"
            value={form.water_type_id}
            disabled={!!lockedWaterTypeId}
            onChange={e => setForm({ ...form, water_type_id: e.target.value })}
          >
            <option value="">Unclassified (generic tariff rate)</option>
            {waterTypes?.map(wt => <option key={wt.id} value={wt.id}>{wt.name}</option>)}
          </select>
          {lockedWaterTypeId && (
            <p className="text-xs text-slate-500 mt-1">
              Locked to this customer's existing water type — a customer has exactly one water type.
            </p>
          )}
        </div>

        {[
          { label: `Device EUI${form.reading_mode === 'manual' ? ' (optional — no radio)' : ''}`, key: 'device_eui' },
          { label: 'Meter Number', key: 'meter_number' },
          { label: 'Customer', key: 'customer_id', type: 'select' },
          { label: 'Application ID', key: 'application_id' },
          { label: 'Latitude', key: 'latitude' },
          { label: 'Longitude', key: 'longitude' },
          { label: 'Firmware Version', key: 'firmware_version' }
        ].map(field => (
          <div key={field.key}>
            <label className="block text-xs text-slate-400 mb-1 font-medium">{field.label}</label>
            {field.type === 'select' ? (
              <select className="select" value={form.customer_id} onChange={e => handleCustomerChange(e.target.value)}>
                <option value="">Select customer</option>
                {customers?.map(c => <option key={c.id} value={c.id}>{c.full_name} ({c.customer_number})</option>)}
              </select>
            ) : (
              <input className="input" value={form[field.key]} onChange={e => setForm({ ...form, [field.key]: e.target.value })} />
            )}
          </div>
        ))}

        <div className="lg:col-span-2">
          <label className="block text-xs text-slate-400 mb-1 font-medium">Installation Address</label>
          <textarea className="input min-h-[128px]" value={form.installation_address} onChange={e => setForm({ ...form, installation_address: e.target.value })} />
        </div>

        <div className="lg:col-span-2">
          <label className="block text-xs text-slate-400 mb-1 font-medium">Notes</label>
          <textarea className="input min-h-[100px]" value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} />
        </div>
      </div>

      <div className="flex justify-end gap-3">
        <button onClick={() => router.push('/dashboard/meters')} className="btn-secondary">Cancel</button>
        <button onClick={() => mutation.mutate(form)} disabled={mutation.isLoading} className="btn-primary">
          {mutation.isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Create Meter
        </button>
      </div>
    </div>
  );
}
