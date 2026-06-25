'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { customersAPI } from '../../../lib/api';
import { Users, Search, Plus, Phone, Mail, Gauge, ChevronRight } from 'lucide-react';
import Link from 'next/link';

const TARIFF_CLS = {
  residential: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  commercial:  'bg-amber-500/10 text-amber-400 border-amber-500/20',
  industrial:  'bg-purple-500/10 text-purple-400 border-purple-500/20',
  government:  'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
};

export default function CustomersPage() {
  const [search, setSearch] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['customers', search],
    queryFn: () => customersAPI.list({ search, limit: 100 }).then(r => r.data),
  });

  const customers = data?.data || [];

  return (
    <div className="p-4 lg:p-6 space-y-5 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white font-display">Customers</h1>
          <p className="text-slate-400 text-sm mt-0.5">{customers.length} customers</p>
        </div>
        <Link href="/dashboard/customers/add" className="btn-primary text-sm">
          <Plus className="w-4 h-4" />
          Add Customer
        </Link>
      </div>

      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
        <input
          className="input pl-9"
          placeholder="Search customers..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      <div className="card-glow overflow-hidden">
        <table className="data-table">
          <thead>
            <tr>
              <th>Customer No.</th>
              <th>Full Name</th>
              <th>Contact</th>
              <th>City</th>
              <th>Tariff</th>
              <th>Status</th>
              <th>Meters</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <tr key={i}>
                  {Array.from({ length: 8 }).map((_, j) => (
                    <td key={j}><div className="h-4 bg-slate-800 rounded animate-pulse" /></td>
                  ))}
                </tr>
              ))
            ) : customers.length === 0 ? (
              <tr>
                <td colSpan={8} className="text-center py-12 text-slate-500">
                  <Users className="w-10 h-10 mx-auto mb-2 opacity-30" />
                  <p>No customers found</p>
                </td>
              </tr>
            ) : (
              customers.map(c => (
                <tr key={c.id}>
                  <td><span className="font-mono text-xs text-primary-400">{c.customer_number}</span></td>
                  <td><span className="font-medium text-white">{c.full_name}</span></td>
                  <td>
                    <div className="space-y-0.5">
                      {c.email && <div className="flex items-center gap-1 text-xs text-slate-400"><Mail className="w-3 h-3" />{c.email}</div>}
                      {c.phone && <div className="flex items-center gap-1 text-xs text-slate-400"><Phone className="w-3 h-3" />{c.phone}</div>}
                    </div>
                  </td>
                  <td><span className="text-slate-400 text-sm">{c.city || '—'}</span></td>
                  <td>
                    <span className={`text-xs px-2 py-0.5 rounded-full border capitalize ${TARIFF_CLS[c.tariff_type] || ''}`}>
                      {c.tariff_type}
                    </span>
                  </td>
                  <td>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                      c.account_status === 'active' ? 'bg-emerald-500/10 text-emerald-400' :
                      c.account_status === 'suspended' ? 'bg-amber-500/10 text-amber-400' :
                      'bg-red-500/10 text-red-400'
                    }`}>{c.account_status}</span>
                  </td>
                  <td>
                    <div className="flex items-center gap-1 text-slate-400">
                      <Gauge className="w-3 h-3" />
                      <span className="text-sm">{c.meter_count || 0}</span>
                    </div>
                  </td>
                  <td>
                    <Link href={`/dashboard/customers/${c.id}`}
                      className="p-1.5 text-slate-500 hover:text-primary-400 hover:bg-slate-800 rounded-lg transition-colors block">
                      <ChevronRight className="w-4 h-4" />
                    </Link>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
