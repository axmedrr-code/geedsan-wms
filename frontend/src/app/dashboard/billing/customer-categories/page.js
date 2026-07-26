'use client';
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { customerCategoriesAPI } from '../../../../lib/api';
import { Tag, Plus, Loader2, Edit, X, Save, ArrowLeft, Ban, CheckCircle } from 'lucide-react';
import toast from 'react-hot-toast';

function CategoryForm({ initial = {}, onSave, onCancel, loading }) {
  const [form, setForm] = useState({
    code:        initial.code        || '',
    name:        initial.name        || '',
    description: initial.description || '',
  });
  const isEdit = !!initial.id;

  return (
    <div className="card-glow border-primary-500/20 p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-white">{isEdit ? 'Edit Customer Category' : 'New Customer Category'}</h3>
        <button onClick={onCancel} className="btn-ghost p-1.5"><X className="w-4 h-4" /></button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {!isEdit && (
          <div>
            <label className="block text-xs text-slate-400 mb-1 font-medium">Code <span className="text-red-400">*</span></label>
            <input
              className="input font-mono lowercase"
              placeholder="e.g. residential"
              value={form.code}
              onChange={e => setForm(p => ({ ...p, code: e.target.value.toLowerCase().trim() }))}
            />
          </div>
        )}
        <div className={!isEdit ? '' : 'sm:col-span-2'}>
          <label className="block text-xs text-slate-400 mb-1 font-medium">Name <span className="text-red-400">*</span></label>
          <input
            className="input"
            placeholder="e.g. Residential"
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
      </div>

      <div className="flex justify-end gap-3">
        <button onClick={onCancel} className="btn-secondary">Cancel</button>
        <button onClick={() => onSave(form)} disabled={loading} className="btn-primary">
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          {isEdit ? 'Save Changes' : 'Create Category'}
        </button>
      </div>
    </div>
  );
}

export default function CustomerCategoriesPage() {
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState(null);

  const { data: categories = [], isLoading } = useQuery({
    queryKey: ['customer-categories'],
    queryFn: () => customerCategoriesAPI.list().then(r => r.data),
  });

  const createMut = useMutation({
    mutationFn: (d) => customerCategoriesAPI.create(d),
    onSuccess: () => {
      toast.success('Customer category created');
      qc.invalidateQueries({ queryKey: ['customer-categories'] });
      setShowCreate(false);
    },
    onError: (err) => toast.error(err.response?.data?.error || 'Failed to create category'),
  });

  const updateMut = useMutation({
    mutationFn: ({ id, data }) => customerCategoriesAPI.update(id, data),
    onSuccess: () => {
      toast.success('Customer category updated');
      qc.invalidateQueries({ queryKey: ['customer-categories'] });
      setEditing(null);
    },
    onError: (err) => toast.error(err.response?.data?.error || 'Failed to update category'),
  });

  const toggleActive = (cat) => {
    updateMut.mutate({ id: cat.id, data: { is_active: !cat.is_active } });
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
          <h1 className="text-2xl font-bold text-white font-display">Customer Categories</h1>
          <p className="text-slate-400 text-sm mt-0.5">
            {categories.length} categor{categories.length !== 1 ? 'ies' : 'y'} — used for tariff assignment
          </p>
        </div>
        <button onClick={() => { setShowCreate(true); setEditing(null); }} className="btn-primary text-sm">
          <Plus className="w-4 h-4" /> New Category
        </button>
      </div>

      {showCreate && (
        <CategoryForm
          onSave={(d) => createMut.mutate(d)}
          onCancel={() => setShowCreate(false)}
          loading={createMut.isPending}
        />
      )}

      {editing && (
        <CategoryForm
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
                <th></th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                Array.from({ length: 3 }).map((_, i) => (
                  <tr key={i}>
                    {Array.from({ length: 5 }).map((_, j) => (
                      <td key={j}><div className="h-4 bg-slate-800 rounded animate-pulse" /></td>
                    ))}
                  </tr>
                ))
              ) : categories.length === 0 ? (
                <tr>
                  <td colSpan={5} className="text-center py-16 text-slate-500">
                    <Tag className="w-10 h-10 mx-auto mb-3 opacity-25" />
                    <p className="font-medium">No customer categories configured</p>
                    <p className="text-xs mt-1">Create a category to get started</p>
                  </td>
                </tr>
              ) : (
                categories.map(cat => (
                  <tr key={cat.id}>
                    <td><span className="font-mono font-bold text-primary-400 text-sm">{cat.code}</span></td>
                    <td><span className="font-medium text-white">{cat.name}</span></td>
                    <td><span className="text-slate-400 text-sm">{cat.description || '—'}</span></td>
                    <td>
                      <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${cat.is_active !== false ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-slate-700/50 text-slate-400 border-slate-700'}`}>
                        {cat.is_active !== false ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td>
                      <div className="flex items-center gap-1">
                        <button onClick={() => { setEditing(cat); setShowCreate(false); }} className="btn-ghost py-1 px-2 text-xs">
                          <Edit className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => toggleActive(cat)}
                          disabled={updateMut.isPending}
                          className={`btn-ghost py-1 px-2 text-xs ${cat.is_active !== false ? 'text-red-400 hover:text-red-300' : 'text-emerald-400 hover:text-emerald-300'}`}
                          title={cat.is_active !== false ? 'Deactivate' : 'Activate'}
                        >
                          {cat.is_active !== false ? <Ban className="w-3.5 h-3.5" /> : <CheckCircle className="w-3.5 h-3.5" />}
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
