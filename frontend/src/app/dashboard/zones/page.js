'use client';
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { zonesAPI } from '../../../lib/api';
import { Map, Plus, Loader2, Edit, Trash2, X, Save, Users, Gauge } from 'lucide-react';
import toast from 'react-hot-toast';

const STATUS_CLS = {
  active:   'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  inactive: 'bg-slate-700/50 text-slate-400 border-slate-700',
};

function ZoneForm({ initial = {}, onSave, onCancel, loading }) {
  const [form, setForm] = useState({
    zone_code:   initial.zone_code   || '',
    zone_name:   initial.zone_name   || '',
    description: initial.description || '',
    status:      initial.status      || 'active',
  });
  const isEdit = !!initial.id;

  return (
    <div className="card-glow border-primary-500/20 p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-white">{isEdit ? 'Edit Zone' : 'New Zone'}</h3>
        <button onClick={onCancel} className="btn-ghost p-1.5"><X className="w-4 h-4" /></button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {!isEdit && (
          <div>
            <label className="block text-xs text-slate-400 mb-1 font-medium">Zone Code <span className="text-red-400">*</span></label>
            <input
              className="input font-mono uppercase"
              placeholder="e.g. ZA"
              maxLength={10}
              value={form.zone_code}
              onChange={e => setForm(p => ({ ...p, zone_code: e.target.value.toUpperCase() }))}
            />
          </div>
        )}
        <div className={!isEdit ? '' : 'sm:col-span-2'}>
          <label className="block text-xs text-slate-400 mb-1 font-medium">Zone Name <span className="text-red-400">*</span></label>
          <input
            className="input"
            placeholder="e.g. Garowe Central"
            value={form.zone_name}
            onChange={e => setForm(p => ({ ...p, zone_name: e.target.value }))}
          />
        </div>
        <div className="sm:col-span-2">
          <label className="block text-xs text-slate-400 mb-1 font-medium">Description</label>
          <input
            className="input"
            placeholder="Optional description"
            value={form.description}
            onChange={e => setForm(p => ({ ...p, description: e.target.value }))}
          />
        </div>
        {isEdit && (
          <div>
            <label className="block text-xs text-slate-400 mb-1 font-medium">Status</label>
            <select className="select" value={form.status} onChange={e => setForm(p => ({ ...p, status: e.target.value }))}>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
          </div>
        )}
      </div>

      <div className="flex justify-end gap-3">
        <button onClick={onCancel} className="btn-secondary">Cancel</button>
        <button onClick={() => onSave(form)} disabled={loading} className="btn-primary">
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          {isEdit ? 'Save Changes' : 'Create Zone'}
        </button>
      </div>
    </div>
  );
}

export default function ZonesPage() {
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState(null);

  const { data: zones = [], isLoading } = useQuery({
    queryKey: ['zones'],
    queryFn: () => zonesAPI.list().then(r => r.data),
  });

  const createMut = useMutation({
    mutationFn: (d) => zonesAPI.create(d),
    onSuccess: () => {
      toast.success('Zone created');
      qc.invalidateQueries({ queryKey: ['zones'] });
      setShowCreate(false);
    },
    onError: (err) => toast.error(err.response?.data?.error || 'Failed to create zone'),
  });

  const updateMut = useMutation({
    mutationFn: ({ id, data }) => zonesAPI.update(id, data),
    onSuccess: () => {
      toast.success('Zone updated');
      qc.invalidateQueries({ queryKey: ['zones'] });
      setEditing(null);
    },
    onError: (err) => toast.error(err.response?.data?.error || 'Failed to update zone'),
  });

  const deleteMut = useMutation({
    mutationFn: (id) => zonesAPI.delete(id),
    onSuccess: () => {
      toast.success('Zone deleted');
      qc.invalidateQueries({ queryKey: ['zones'] });
    },
    onError: (err) => toast.error(err.response?.data?.error || 'Failed to delete zone'),
  });

  const handleDelete = (zone) => {
    if (!confirm(`Delete zone ${zone.zone_code} — ${zone.zone_name}? This cannot be undone.`)) return;
    deleteMut.mutate(zone.id);
  };

  return (
    <div className="p-4 lg:p-6 space-y-5 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white font-display">Zones</h1>
          <p className="text-slate-400 text-sm mt-0.5">
            {zones.length} zone{zones.length !== 1 ? 's' : ''} — Garowe distribution zones
          </p>
        </div>
        <button onClick={() => { setShowCreate(true); setEditing(null); }} className="btn-primary text-sm">
          <Plus className="w-4 h-4" /> New Zone
        </button>
      </div>

      {showCreate && (
        <ZoneForm
          onSave={(d) => createMut.mutate(d)}
          onCancel={() => setShowCreate(false)}
          loading={createMut.isPending}
        />
      )}

      {editing && (
        <ZoneForm
          initial={editing}
          onSave={(d) => updateMut.mutate({ id: editing.id, data: d })}
          onCancel={() => setEditing(null)}
          loading={updateMut.isPending}
        />
      )}

      <div className="card-glow overflow-hidden">
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Code</th>
                <th>Name</th>
                <th>Description</th>
                <th>Status</th>
                <th>Customers</th>
                <th>Meters</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                Array.from({ length: 4 }).map((_, i) => (
                  <tr key={i}>
                    {Array.from({ length: 7 }).map((_, j) => (
                      <td key={j}><div className="h-4 bg-slate-800 rounded animate-pulse" /></td>
                    ))}
                  </tr>
                ))
              ) : zones.length === 0 ? (
                <tr>
                  <td colSpan={7} className="text-center py-16 text-slate-500">
                    <Map className="w-10 h-10 mx-auto mb-3 opacity-25" />
                    <p className="font-medium">No zones configured</p>
                    <p className="text-xs mt-1">Create a zone to get started</p>
                  </td>
                </tr>
              ) : (
                zones.map(z => (
                  <tr key={z.id}>
                    <td>
                      <span className="font-mono font-bold text-primary-400 text-sm">{z.zone_code}</span>
                    </td>
                    <td>
                      <span className="font-medium text-white">{z.zone_name}</span>
                    </td>
                    <td>
                      <span className="text-slate-400 text-sm">{z.description || '—'}</span>
                    </td>
                    <td>
                      <span className={`text-xs px-2 py-0.5 rounded-full border font-medium capitalize ${STATUS_CLS[z.status] || 'text-slate-400'}`}>
                        {z.status}
                      </span>
                    </td>
                    <td>
                      <div className="flex items-center gap-1.5 text-sm text-slate-300">
                        <Users className="w-3.5 h-3.5 text-slate-500" />
                        {z.customer_count || 0}
                      </div>
                    </td>
                    <td>
                      <div className="flex items-center gap-1.5 text-sm text-slate-300">
                        <Gauge className="w-3.5 h-3.5 text-slate-500" />
                        {z.meter_count || 0}
                      </div>
                    </td>
                    <td>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => { setEditing(z); setShowCreate(false); }}
                          className="btn-ghost py-1 px-2 text-xs"
                        >
                          <Edit className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => handleDelete(z)}
                          disabled={deleteMut.isPending}
                          className="btn-ghost py-1 px-2 text-xs text-red-400 hover:text-red-300"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
