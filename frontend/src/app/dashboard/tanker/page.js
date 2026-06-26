'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { tankerAPI } from '../../../lib/api';
import { Loader2, Plus, ArrowRight, Search } from 'lucide-react';

export default function TankerPage() {
  const [search, setSearch] = useState('');
  const { data, isLoading } = useQuery({
    queryKey: ['tanker', search],
    queryFn: () => tankerAPI.list({ search, limit: 100 }).then(r => r.data)
  });

  const deliveries = data?.data || [];

  return (
    <div className="p-4 lg:p-6 space-y-5 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white font-display">Tanker Deliveries</h1>
          <p className="text-slate-400 text-sm mt-0.5">Track water tanker dispatches and delivery status.</p>
        </div>
        <Link href="/dashboard/tanker/create" className="btn-primary text-sm flex items-center gap-2"><Plus className="w-4 h-4" /> New Delivery</Link>
      </div>

      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
        <input className="input pl-9" placeholder="Search deliveries..." value={search} onChange={e => setSearch(e.target.value)} />
      </div>

      <div className="card-glow overflow-hidden">
        {isLoading ? (
          <div className="flex items-center justify-center p-12"><Loader2 className="w-6 h-6 text-primary-400 animate-spin" /></div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Reference</th>
                <th>Customer</th>
                <th>Volume</th>
                <th>Status</th>
                <th>Scheduled</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {deliveries.length === 0 ? (
                <tr><td colSpan={6} className="text-center py-12 text-slate-500">No deliveries found</td></tr>
              ) : deliveries.map(item => (
                <tr key={item.id}>
                  <td>{item.delivery_reference}</td>
                  <td>{item.customer_name || 'Unknown'}</td>
                  <td>{item.water_volume_liters} L</td>
                  <td><span className="text-xs px-2 py-1 rounded-full bg-slate-800 border border-slate-700">{item.status}</span></td>
                  <td className="text-slate-400 text-sm">{new Date(item.scheduled_date).toLocaleDateString()}</td>
                  <td><Link href={`/dashboard/tanker/${item.id}`} className="text-primary-400 hover:text-primary-300"><ArrowRight className="w-4 h-4" /></Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
