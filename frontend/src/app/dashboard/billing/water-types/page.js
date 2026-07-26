'use client';
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { waterTypesAPI } from '../../../../lib/api';
import { Droplet, Plus, Loader2, Edit, X, Save, ArrowLeft, Ban, CheckCircle } from 'lucide-react';
import toast from 'react-hot-toast';

function WaterTypeForm({ initial = {}, onSave, onCancel, loading }) {
  const [form, setForm] = useState({
    code:        initial.code        || '',
    name:        initial.name        || '',
    description: initial.description || '',
    is_default:  initial.is_default  || false,
  });
  const isEdit = !!initial.id;

  return (
    <div className="card-glow border-primary-500/20 p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-white">{isEdit ? 'Edit Water Type' : 'New Water Type'}</h3>
        <button onClick={onCancel} className="btn-ghost p-1.5"><X className="w-4 h-4" /></button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {!isEdit && (
          <div>
            <label className="block text-xs text-slate-400 mb-1 font-medium">Code <span className="text-red-400">*</span></label>
            <input
              className="input font-mono lowercase"
              placeholder="e.g. distilled"
              value={form.code}
              onChange={e => setForm(p => ({ ...p, code: e.target.value.toLowerCase().trim() }))}
            />
          </div>
        )}
        <div className={!isEdit ? '' : 'sm:col-span-2'}>
          <label className="block text-xs text-slate-400 mb-1 font-medium">Name <span className="text-red-400">*</span></label>
          <input
            className="input"
            placeholder="e.g. Distilled Water"
            value={form.name}
            onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
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
        <div className="sm:col-span-2 flex items-center gap-2">
          <input
            id="is_default"
            type="checkbox"
            checked={form.is_default}
            onChange={e => setForm(p => ({ ...p, is_default: e.target.checked }))}
          />
          <label htmlFor="is_default" className="text-sm text-slate-300">
            Default water type (used when a meter has none assigned)
          </label>
        </div>
      </div>

      <div className="flex justify-end gap-3">
        <button onClick={onCancel} className="btn-secondary">Cancel</button>
        <button onClick={() => onSave(form)} disabled={loading} className="btn-primary">
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          {isEdit ? 'Save Changes' : 'Create Water Type'}
        </button>
      </div>
    </div>
  );
}

export default function WaterTypesPage() {
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState(null);

  const { data: waterTypes = [], isLoading } = useQuery({
    queryKey: ['water-types'],
    queryFn: () => waterTypesAPI.list().then(r => r.data),
  });

  const createMut = useMutation({
    mutationFn: (d) => waterTypesAPI.create(d),
    onSuccess: () => {
      toast.success('Water type created');
      qc.invalidateQueries({ queryKey: ['water-types'] });
      setShowCreate(false);
    },
    onError: (err) => toast.error(err.response?.data?.error || 'Failed to create water type'),
  });

  const updateMut = useMutation({
    mutationFn: ({ id, data }) => waterTypesAPI.update(id, data),
    onSuccess: () => {
      toast.success('Water type updated');
      qc.invalidateQueries({ queryKey: ['water-types'] });
      setEditing(null);
    },
    onError: (err) => toast.error(err.response?.data?.error || 'Failed to update water type'),
  });

  const toggleActive = (wt) => {
    updateMut.mutate({ id: wt.id, data: { is_active: !wt.is_active } });
  };

  return (
    <div className="p-4 lg:p-6 space-y-5 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2 text-sm text-slate-500 mb-1">
            <Link href="/dashboard/billing" className="flex items-center gap-1 hover:text-slate-300">
              <ArrowLeft className="w-3.5 h-3.5" /> Billing Center
            </Link>
          </div>
          <h1 className="text-2xl font-bold text-white font-display">Water Types</h1>
          <p className="text-slate-400 text-sm mt-0.5">
            {waterTypes.length} water type{waterTypes.length !== 1 ? 's' : ''} — sold at independent tariff rates
          </p>
        </div>
        <button onClick={() => { setShowCreate(true); setEditing(null); }} className="btn-primary text-sm">
          <Plus className="w-4 h-4" /> New Water Type
        </button>
      </div>

      {showCreate && (
        <WaterTypeForm
          onSave={(d) => createMut.mutate(d)}
          onCancel={() => setShowCreate(false)}
          loading={createMut.isPending}
        />
      )}

      {editing && (
        <WaterTypeForm
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
                <th>Default</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                Array.from({ length: 3 }).map((_, i) => (
                  <tr key={i}>
                    {Array.from({ length: 6 }).map((_, j) => (
                      <td key={j}><div className="h-4 bg-slate-800 rounded animate-pulse" /></td>
                    ))}
                  </tr>
                ))
              ) : waterTypes.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-center py-16 text-slate-500">
                    <Droplet className="w-10 h-10 mx-auto mb-3 opacity-25" />
                    <p className="font-medium">No water types configured</p>
                    <p className="text-xs mt-1">Create a water type to get started</p>
                  </td>
                </tr>
              ) : (
                waterTypes.map(wt => (
                  <tr key={wt.id}>
                    <td><span className="font-mono font-bold text-primary-400 text-sm">{wt.code}</span></td>
                    <td><span className="font-medium text-white">{wt.name}</span></td>
                    <td><span className="text-slate-400 text-sm">{wt.description || '—'}</span></td>
                    <td>
                      {wt.is_default && (
                        <span className="text-xs px-2 py-0.5 rounded-full border bg-primary-500/10 text-primary-400 border-primary-500/20 font-medium">Default</span>
                      )}
                    </td>
                    <td>
                      <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${wt.is_active !== false ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-slate-700/50 text-slate-400 border-slate-700'}`}>
                        {wt.is_active !== false ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td>
                      <div className="flex items-center gap-1">
                        <button onClick={() => { setEditing(wt); setShowCreate(false); }} className="btn-ghost py-1 px-2 text-xs">
                          <Edit className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => toggleActive(wt)}
                          disabled={updateMut.isPending}
                          className={`btn-ghost py-1 px-2 text-xs ${wt.is_active !== false ? 'text-red-400 hover:text-red-300' : 'text-emerald-400 hover:text-emerald-300'}`}
                          title={wt.is_active !== false ? 'Deactivate' : 'Activate'}
                        >
                          {wt.is_active !== false ? <Ban className="w-3.5 h-3.5" /> : <CheckCircle className="w-3.5 h-3.5" />}
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
