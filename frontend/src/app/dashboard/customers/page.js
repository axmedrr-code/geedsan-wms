'use client';
import { useState, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { customersAPI } from '../../../lib/api';
import {
  Users, Search, Plus, Phone, Mail, Gauge, ChevronRight,
  Wifi, WifiOff, DollarSign, Calendar, Filter, X
} from 'lucide-react';
import Link from 'next/link';
import { format } from 'date-fns';

const TARIFF_CLS = {
  residential: 'bg-blue-500/10 text-blue-400 border border-blue-500/20',
  commercial:  'bg-amber-500/10 text-amber-400 border border-amber-500/20',
  industrial:  'bg-purple-500/10 text-purple-400 border border-purple-500/20',
  government:  'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20',
};

const STATUS_CLS = {
  active:     'bg-emerald-500/10 text-emerald-400',
  suspended:  'bg-amber-500/10 text-amber-400',
  terminated: 'bg-red-500/10 text-red-400',
};

const FILTERS = [
  { key: 'status',        value: 'active',    label: 'Active' },
  { key: 'status',        value: 'suspended', label: 'Suspended' },
  { key: 'tariff',        value: 'residential', label: 'Residential' },
  { key: 'tariff',        value: 'commercial',  label: 'Commercial' },
  { key: 'has_balance',   value: 'true',      label: 'Has Balance' },
  { key: 'no_meter',      value: 'true',      label: 'No Meter' },
  { key: 'online_meter',  value: 'true',      label: 'Online Meter' },
  { key: 'offline_meter', value: 'true',      label: 'Offline Meter' },
];

function fmtBalance(n) {
  const num = parseFloat(n) || 0;
  if (num === 0) return null;
  return num.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });
}

export default function CustomersPage() {
  const [search, setSearch]     = useState('');
  const [activeFilters, setActiveFilters] = useState({});

  const toggleFilter = useCallback((key, value) => {
    setActiveFilters(prev => {
      if (prev[key] === value) {
        const next = { ...prev };
        delete next[key];
        return next;
      }
      // status and tariff are mutually exclusive within their group
      return { ...prev, [key]: value };
    });
  }, []);

  const clearAll = () => { setSearch(''); setActiveFilters({}); };

  const queryParams = { search: search || undefined, ...activeFilters, limit: 200 };

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['customers', queryParams],
    queryFn: () => customersAPI.list(queryParams).then(r => r.data),
    keepPreviousData: true,
  });

  const customers = data?.data || [];
  const total     = data?.total ?? customers.length;
  const hasFilters = search || Object.keys(activeFilters).length > 0;

  return (
    <div className="p-4 lg:p-6 space-y-5 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white font-display">Customers</h1>
          <p className="text-slate-400 text-sm mt-0.5">
            {isFetching && !isLoading ? 'Updating…' : `${total} customer${total !== 1 ? 's' : ''}`}
          </p>
        </div>
        <Link href="/dashboard/customers/add" className="btn-primary text-sm">
          <Plus className="w-4 h-4" />
          Add Customer
        </Link>
      </div>

      {/* Search + filters */}
      <div className="space-y-3">
        <div className="relative max-w-lg">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
          <input
            className="input pl-9 w-full"
            placeholder="Search by name, phone, customer #, meter #, device EUI, national ID…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          {search && (
            <button onClick={() => setSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300">
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Filter className="w-3.5 h-3.5 text-slate-500 shrink-0" />
          {FILTERS.map(f => {
            const active = activeFilters[f.key] === f.value;
            return (
              <button
                key={`${f.key}-${f.value}`}
                onClick={() => toggleFilter(f.key, f.value)}
                className={`text-xs px-3 py-1 rounded-full border transition-colors ${
                  active
                    ? 'bg-primary-500/20 text-primary-300 border-primary-500/40'
                    : 'bg-slate-800/60 text-slate-400 border-slate-700/50 hover:border-slate-500 hover:text-slate-300'
                }`}
              >
                {f.label}
              </button>
            );
          })}
          {hasFilters && (
            <button onClick={clearAll} className="text-xs text-slate-500 hover:text-slate-300 ml-1 underline">
              Clear all
            </button>
          )}
        </div>
      </div>

      {/* Table */}
      <div className="card-glow overflow-hidden">
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Customer No.</th>
                <th>Name</th>
                <th>Phone</th>
                <th>City</th>
                <th>Tariff</th>
                <th>Status</th>
                <th>Balance</th>
                <th>Meters</th>
                <th>Last Reading</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i}>
                    {Array.from({ length: 10 }).map((_, j) => (
                      <td key={j}><div className="h-4 bg-slate-800 rounded animate-pulse" /></td>
                    ))}
                  </tr>
                ))
              ) : customers.length === 0 ? (
                <tr>
                  <td colSpan={10} className="text-center py-16 text-slate-500">
                    <Users className="w-10 h-10 mx-auto mb-3 opacity-25" />
                    <p className="font-medium">No customers found</p>
                    {hasFilters && (
                      <button onClick={clearAll} className="mt-2 text-xs text-primary-400 hover:underline">
                        Clear filters
                      </button>
                    )}
                  </td>
                </tr>
              ) : (
                customers.map(c => {
                  const balance = fmtBalance(c.outstanding_balance);
                  const meters  = parseInt(c.meter_count) || 0;
                  const online  = parseInt(c.online_count) || 0;

                  return (
                    <tr
                      key={c.id}
                      className="cursor-pointer hover:bg-slate-800/30 transition-colors"
                      onClick={() => window.location.href = `/dashboard/customers/${c.id}`}
                    >
                      <td onClick={e => e.stopPropagation()}>
                        <Link
                          href={`/dashboard/customers/${c.id}`}
                          className="font-mono text-xs text-primary-400 hover:text-primary-300"
                        >
                          {c.customer_number}
                        </Link>
                      </td>

                      <td>
                        <div>
                          <span className="font-medium text-white">{c.full_name}</span>
                          {c.email && (
                            <div className="flex items-center gap-1 text-xs text-slate-500 mt-0.5">
                              <Mail className="w-3 h-3" />{c.email}
                            </div>
                          )}
                        </div>
                      </td>

                      <td>
                        {c.phone ? (
                          <div className="flex items-center gap-1 text-sm text-slate-300">
                            <Phone className="w-3 h-3 text-slate-500" />{c.phone}
                          </div>
                        ) : <span className="text-slate-600">—</span>}
                      </td>

                      <td>
                        <span className="text-slate-300 text-sm">{c.city || <span className="text-slate-600">—</span>}</span>
                      </td>

                      <td>
                        <span className={`text-xs px-2 py-0.5 rounded-full capitalize ${TARIFF_CLS[c.tariff_type] || 'text-slate-400'}`}>
                          {c.tariff_type}
                        </span>
                      </td>

                      <td>
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium capitalize ${STATUS_CLS[c.account_status] || 'text-slate-400'}`}>
                          {c.account_status}
                        </span>
                      </td>

                      <td>
                        {balance ? (
                          <div className="flex items-center gap-1 text-amber-400 text-sm font-medium">
                            <DollarSign className="w-3 h-3" />
                            {balance.replace('$', '')}
                          </div>
                        ) : (
                          <span className="text-emerald-500 text-xs">Paid</span>
                        )}
                      </td>

                      <td>
                        <div className="flex items-center gap-1.5">
                          <Gauge className="w-3.5 h-3.5 text-slate-500" />
                          <span className="text-sm text-slate-300">{meters}</span>
                          {meters > 0 && (
                            <span className={`text-xs ${online > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                              {online > 0
                                ? <Wifi className="w-3 h-3 inline" />
                                : <WifiOff className="w-3 h-3 inline" />}
                            </span>
                          )}
                        </div>
                      </td>

                      <td>
                        {c.last_reading_date ? (
                          <div className="flex items-center gap-1 text-xs text-slate-400">
                            <Calendar className="w-3 h-3" />
                            {format(new Date(c.last_reading_date), 'dd MMM yyyy')}
                          </div>
                        ) : (
                          <span className="text-slate-600 text-xs">No readings</span>
                        )}
                      </td>

                      <td onClick={e => e.stopPropagation()}>
                        <Link
                          href={`/dashboard/customers/${c.id}`}
                          className="p-1.5 text-slate-500 hover:text-primary-400 hover:bg-slate-800 rounded-lg transition-colors block"
                        >
                          <ChevronRight className="w-4 h-4" />
                        </Link>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {customers.length > 0 && (
          <div className="px-4 py-2.5 border-t border-slate-800/60 text-xs text-slate-500">
            Showing {customers.length} of {total} customers
          </div>
        )}
      </div>
    </div>
  );
}
