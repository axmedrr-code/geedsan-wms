'use client';
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { usersAPI } from '../../../lib/api';
import { Shield, Plus, Edit, Trash2, CheckCircle, XCircle, Loader2, X } from 'lucide-react';
import { format } from 'date-fns';
import toast from 'react-hot-toast';
import { useAuthStore } from '../../../store/authStore';

const ROLE_CLS = {
  admin:    'bg-purple-500/10 text-purple-400 border-purple-500/20',
  operator: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  viewer:   'bg-slate-500/10 text-slate-400 border-slate-700',
};

function Modal({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-md p-6 shadow-2xl animate-slide-up">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-semibold text-white">{title}</h2>
          <button onClick={onClose} className="p-1 text-slate-500 hover:text-white"><X className="w-5 h-5" /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

export default function UsersPage() {
  const { user: currentUser } = useAuthStore();
  const queryClient = useQueryClient();
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState({ username: '', email: '', password: '', full_name: '', role: 'viewer' });

  if (currentUser?.role !== 'admin') {
    return (
      <div className="p-6 text-center text-slate-400">
        <Shield className="w-12 h-12 mx-auto mb-3 opacity-30" />
        <p>Admin access required</p>
      </div>
    );
  }

  const { data: users, isLoading } = useQuery({
    queryKey: ['users'],
    queryFn: () => usersAPI.list().then(r => r.data)
  });

  const createMutation = useMutation({
    mutationFn: usersAPI.create,
    onSuccess: () => {
      toast.success('User created');
      queryClient.invalidateQueries(['users']);
      setShowModal(false);
      setForm({ username: '', email: '', password: '', full_name: '', role: 'viewer' });
    },
    onError: (err) => toast.error(err.response?.data?.error || 'Failed to create user')
  });

  const deactivateMutation = useMutation({
    mutationFn: usersAPI.deactivate,
    onSuccess: () => { toast.success('User deactivated'); queryClient.invalidateQueries(['users']); },
    onError: () => toast.error('Failed to deactivate user')
  });

  const handleSubmit = (e) => {
    e.preventDefault();
    createMutation.mutate(form);
  };

  return (
    <div className="p-4 lg:p-6 space-y-5 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white font-display">Users</h1>
          <p className="text-slate-400 text-sm mt-0.5">{users?.length || 0} accounts</p>
        </div>
        <button onClick={() => setShowModal(true)} className="btn-primary text-sm">
          <Plus className="w-4 h-4" />
          Add User
        </button>
      </div>

      <div className="card-glow overflow-hidden">
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Username</th>
              <th>Email</th>
              <th>Role</th>
              <th>Status</th>
              <th>Last Login</th>
              <th>Created</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              Array.from({ length: 3 }).map((_, i) => (
                <tr key={i}>
                  {Array.from({ length: 8 }).map((_, j) => (
                    <td key={j}><div className="h-4 bg-slate-800 rounded animate-pulse" /></td>
                  ))}
                </tr>
              ))
            ) : (users || []).map(u => (
              <tr key={u.id}>
                <td>
                  <div className="flex items-center gap-2">
                    <div className="w-7 h-7 rounded-full bg-gradient-to-br from-primary-400 to-primary-700 flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
                      {u.full_name?.[0]}
                    </div>
                    <span className="text-sm font-medium text-white">{u.full_name}</span>
                  </div>
                </td>
                <td><span className="text-slate-400 font-mono text-xs">{u.username}</span></td>
                <td><span className="text-slate-400 text-xs">{u.email}</span></td>
                <td>
                  <span className={`text-xs px-2 py-0.5 rounded-full border capitalize ${ROLE_CLS[u.role]}`}>
                    {u.role}
                  </span>
                </td>
                <td>
                  <span className={`text-xs ${u.is_active ? 'text-emerald-400' : 'text-red-400'}`}>
                    {u.is_active ? '● Active' : '○ Inactive'}
                  </span>
                </td>
                <td><span className="text-slate-500 text-xs">{u.last_login ? format(new Date(u.last_login), 'MM/dd HH:mm') : 'Never'}</span></td>
                <td><span className="text-slate-500 text-xs">{u.created_at ? format(new Date(u.created_at), 'MM/dd/yyyy') : ''}</span></td>
                <td>
                  {u.id !== currentUser?.id && u.is_active && (
                    <button
                      onClick={() => { if (confirm('Deactivate this user?')) deactivateMutation.mutate(u.id); }}
                      className="p-1.5 text-slate-500 hover:text-red-400 hover:bg-slate-800 rounded-lg transition-colors"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showModal && (
        <Modal title="Add New User" onClose={() => setShowModal(false)}>
          <form onSubmit={handleSubmit} className="space-y-4">
            {[
              { key: 'full_name', label: 'Full Name', type: 'text', required: true },
              { key: 'username', label: 'Username', type: 'text', required: true },
              { key: 'email', label: 'Email', type: 'email', required: true },
              { key: 'password', label: 'Password', type: 'password', required: true },
            ].map(field => (
              <div key={field.key}>
                <label className="block text-xs text-slate-400 mb-1.5 font-medium">{field.label}</label>
                <input
                  type={field.type}
                  className="input"
                  required={field.required}
                  value={form[field.key]}
                  onChange={e => setForm(f => ({ ...f, [field.key]: e.target.value }))}
                />
              </div>
            ))}
            <div>
              <label className="block text-xs text-slate-400 mb-1.5 font-medium">Role</label>
              <select className="select" value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))}>
                <option value="viewer">Viewer</option>
                <option value="operator">Operator</option>
                <option value="admin">Admin</option>
              </select>
            </div>
            <div className="flex justify-end gap-3 mt-5">
              <button type="button" onClick={() => setShowModal(false)} className="btn-secondary">Cancel</button>
              <button type="submit" disabled={createMutation.isPending} className="btn-primary">
                {createMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                Create User
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
