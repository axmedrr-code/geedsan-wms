'use client';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '../../store/authStore';
import { Droplets, Loader2, Eye, EyeOff } from 'lucide-react';
import toast from 'react-hot-toast';

export default function LoginPage() {
  const [form, setForm] = useState({ username: '', password: '' });
  const [showPass, setShowPass] = useState(false);
  const [loading, setLoading] = useState(false);
  const { login, user, initialize, isInitialized } = useAuthStore();
  const router = useRouter();

  useEffect(() => { initialize(); }, []);
  useEffect(() => { if (isInitialized && user) router.replace('/dashboard'); }, [user, isInitialized]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.username || !form.password) return toast.error('Please enter credentials');
    setLoading(true);
    try {
      await login(form.username, form.password);
      toast.success('Welcome back!');
      router.replace('/dashboard');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Login failed');
    } finally { setLoading(false); }
  };

  const demoLogin = (username, password) => setForm({ username, password });

  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center p-4">
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-primary-500/5 rounded-full blur-3xl" />
        <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-secondary-500/5 rounded-full blur-3xl" />
      </div>

      <div className="relative w-full max-w-md">
        <div className="card-glow p-8">
          {/* Logo */}
          <div className="text-center mb-8">
            <div className="inline-flex items-center justify-center w-16 h-16 bg-primary-500/10 border border-primary-500/20 rounded-2xl mb-4">
              <Droplets className="w-8 h-8 text-primary-400" />
            </div>
            <h1 className="text-2xl font-bold text-white font-display">GEEDSAN WMS</h1>
            <p className="text-slate-400 text-sm mt-1">Water Meter Management System</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs text-slate-400 mb-1.5 font-medium">Username or Email</label>
              <input
                className="input"
                type="text"
                placeholder="admin"
                value={form.username}
                onChange={e => setForm(f => ({ ...f, username: e.target.value }))}
                required
                autoFocus
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1.5 font-medium">Password</label>
              <div className="relative">
                <input
                  className="input pr-10"
                  type={showPass ? 'text' : 'password'}
                  placeholder="••••••••"
                  value={form.password}
                  onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                  required
                />
                <button type="button" onClick={() => setShowPass(!showPass)} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300">
                  {showPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <button type="submit" disabled={loading} className="w-full btn-primary justify-center py-2.5 text-base mt-2">
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Droplets className="w-4 h-4" />}
              {loading ? 'Signing in...' : 'Sign In'}
            </button>
          </form>

          {/* Demo credentials */}
          <div className="mt-6 p-4 bg-slate-800/50 rounded-xl border border-slate-700/50">
            <p className="text-xs text-slate-500 font-medium mb-3 uppercase tracking-wider">Demo Accounts</p>
            <div className="space-y-2">
              {[
                { role: 'Admin',    user: 'admin',     pass: 'Admin@Geedsan2024', color: 'text-purple-400' },
                { role: 'Operator', user: 'operator1', pass: 'Operator@2024',     color: 'text-blue-400' },
                { role: 'Viewer',   user: 'viewer1',   pass: 'Viewer@2024',       color: 'text-slate-400' },
              ].map(d => (
                <button key={d.role} onClick={() => demoLogin(d.user, d.pass)} className="w-full flex items-center justify-between p-2 rounded-lg hover:bg-slate-700/50 transition-colors text-left">
                  <span className={`text-xs font-semibold ${d.color}`}>{d.role}</span>
                  <span className="text-xs text-slate-500 font-mono">{d.user}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        <p className="text-center text-xs text-slate-600 mt-4">
          GEEDSAN WMS v1.0 · LoRaWAN MLW Meter Dashboard
        </p>
      </div>
    </div>
  );
}
