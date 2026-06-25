'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { metersAPI } from '../../../lib/api';
import Link from 'next/link';
import {
  Search, Filter, Plus, Gauge, Wifi, WifiOff,
  Battery, Signal, Clock, Droplets, ChevronRight, X
} from 'lucide-react';
import { format, formatDistanceToNow } from 'date-fns';
import { clsx } from 'clsx';

const VALVE_BADGE = {
  open:    { label: 'Open',    cls: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' },
  closed:  { label: 'Closed', cls: 'bg-red-500/10 text-red-400 border-red-500/20' },
  unknown: { label: 'Unknown', cls: 'bg-slate-500/10 text-slate-400 border-slate-700' },
  fault:   { label: 'Fault',  cls: 'bg-orange-500/10 text-orange-400 border-orange-500/20' },
};

const batteryColor = (v) => {
  if (!v) return 'text-slate-500';
  if (v < 3.0) return 'text-red-400';
  if (v < 3.2) return 'text-orange-400';
  if (v < 3.6) return 'text-amber-400';
  return 'text-emerald-400';
};

const rssiColor = (r) => {
  if (!r) return 'text-slate-500';
  if (r < -115) return 'text-red-400';
  if (r < -100) return 'text-orange-400';
  if (r < -85) return 'text-amber-400';
  return 'text-emerald-400';
};

export default function MetersPage() {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [page, setPage] = useState(1);
  const [showAdd, setShowAdd] = useState(false);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['meters', search, statusFilter, page],
    queryFn: () => metersAPI.list({ search, status: statusFilter || undefined, page, limit: 50 }).then(r => r.data),
    keepPreviousData: true,
    refetchInterval: 30000
  });

  const meters = data?.data || [];
  const pagination = data?.pagination || {};

  return (
    <div className="p-4 lg:p-6 space-y-5 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white font-display">Meters</h1>
          <p className="text-slate-400 text-sm mt-0.5">{pagination.total || 0} total meters</p>
        </div>
        <Link href="/dashboard/meters/add" className="btn-primary text-sm">
          <Plus className="w-4 h-4" />
          Add Meter
        </Link>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
          <input
            className="input pl-9"
            placeholder="Search EUI, meter no., customer..."
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1); }}
          />
        </div>
        <select
          className="select w-auto"
          value={statusFilter}
          onChange={e => { setStatusFilter(e.target.value); setPage(1); }}
        >
          <option value="">All Status</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
          <option value="faulty">Faulty</option>
        </select>
      </div>

      {/* Table */}
      <div className="card-glow overflow-hidden">
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Device EUI</th>
                <th>Meter No.</th>
                <th>Customer</th>
                <th>Status</th>
                <th>Valve</th>
                <th>Battery</th>
                <th>RSSI</th>
                <th>Last Seen</th>
                <th>Consumption</th>
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
              ) : meters.length === 0 ? (
                <tr>
                  <td colSpan={10} className="text-center py-12 text-slate-500">
                    <Gauge className="w-10 h-10 mx-auto mb-2 opacity-30" />
                    <p>No meters found</p>
                  </td>
                </tr>
              ) : (
                meters.map(meter => (
                  <tr key={meter.id} className="cursor-pointer">
                    <td>
                      <span className="font-mono text-xs text-primary-400">
                        {meter.device_eui}
                      </span>
                    </td>
                    <td>
                      <span className="font-medium text-white">{meter.meter_number}</span>
                    </td>
                    <td>
                      <span className="text-slate-300">{meter.customer_name || <span className="text-slate-600">—</span>}</span>
                    </td>
                    <td>
                      <div className="flex items-center gap-2">
                        {meter.is_online ? (
                          <span className="badge-online">
                            <span className="pulse-dot" />
                            Online
                          </span>
                        ) : (
                          <span className="badge-offline">
                            <WifiOff className="w-3 h-3" />
                            Offline
                          </span>
                        )}
                      </div>
                    </td>
                    <td>
                      {(() => {
                        const v = VALVE_BADGE[meter.valve_status] || VALVE_BADGE.unknown;
                        return (
                          <span className={`inline-flex text-xs px-2 py-0.5 rounded-full border ${v.cls}`}>
                            {v.label}
                          </span>
                        );
                      })()}
                    </td>
                    <td>
                      <span className={`text-sm font-medium font-mono ${batteryColor(meter.battery_voltage)}`}>
                        {meter.battery_voltage ? `${meter.battery_voltage}V` : '—'}
                      </span>
                    </td>
                    <td>
                      <span className={`text-sm font-mono ${rssiColor(meter.rssi)}`}>
                        {meter.rssi ? `${meter.rssi} dBm` : '—'}
                      </span>
                    </td>
                    <td>
                      <span className="text-slate-400 text-xs">
                        {meter.last_seen
                          ? formatDistanceToNow(new Date(meter.last_seen), { addSuffix: true })
                          : <span className="text-slate-600">Never</span>}
                      </span>
                    </td>
                    <td>
                      <span className="text-sm text-white font-medium">
                        {meter.total_consumption
                          ? `${Number(meter.total_consumption).toFixed(2)} m³`
                          : <span className="text-slate-600">—</span>}
                      </span>
                    </td>
                    <td>
                      <Link
                        href={`/dashboard/meters/${meter.id}`}
                        className="p-1.5 text-slate-500 hover:text-primary-400 transition-colors rounded-lg hover:bg-slate-800"
                      >
                        <ChevronRight className="w-4 h-4" />
                      </Link>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {pagination.pages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-slate-800">
            <span className="text-xs text-slate-500">
              Page {pagination.page} of {pagination.pages} ({pagination.total} records)
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1}
                className="btn-secondary text-xs py-1.5 px-3 disabled:opacity-40"
              >
                Previous
              </button>
              <button
                onClick={() => setPage(p => Math.min(pagination.pages, p + 1))}
                disabled={page === pagination.pages}
                className="btn-secondary text-xs py-1.5 px-3 disabled:opacity-40"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
