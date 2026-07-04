'use client';
import { useQuery } from '@tanstack/react-query';
import { systemAPI } from '../../../lib/api';
import { CheckCircle, XCircle, Database, Radio, Server, Globe, Briefcase, HardDriveDownload, AlertTriangle } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

const SERVICE_META = {
  database: { label: 'PostgreSQL', icon: Database },
  mqtt: { label: 'MQTT Broker', icon: Radio },
  backend: { label: 'Backend API', icon: Server },
  frontend: { label: 'Frontend', icon: Globe },
  odoo: { label: 'Odoo ERP', icon: Briefcase },
  chirpstack: { label: 'ChirpStack', icon: Radio }
};

function ServiceCard({ id, info }) {
  const meta = SERVICE_META[id] || { label: id, icon: Server };
  const up = info.status === 'up';
  return (
    <div className="card-glow p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2 text-slate-300 text-sm">
          <meta.icon className="w-4 h-4" />
          {meta.label}
        </div>
        {up ? <CheckCircle className="w-4 h-4 text-emerald-400" /> : <XCircle className="w-4 h-4 text-red-400" />}
      </div>
      <p className={`text-sm font-mono ${up ? 'text-emerald-400' : 'text-red-400'}`}>{info.status.toUpperCase()}</p>
      {info.latencyMs !== undefined && <p className="text-xs text-slate-500 mt-1">{info.latencyMs}ms</p>}
      {info.uptimeSeconds !== undefined && <p className="text-xs text-slate-500 mt-1">up {Math.floor(info.uptimeSeconds / 60)}m</p>}
      {info.error && <p className="text-xs text-red-400/70 mt-1 truncate" title={info.error}>{info.error}</p>}
    </div>
  );
}

export default function SystemHealthPage() {
  const { data, isLoading, refetch } = useQuery({
    queryKey: ['system-health'],
    queryFn: () => systemAPI.getHealth().then(r => r.data),
    refetchInterval: 20000
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-2 border-primary-500/30 border-t-primary-500 rounded-full animate-spin" />
      </div>
    );
  }

  const { status, services = {}, backups = [] } = data || {};

  return (
    <div className="p-4 lg:p-6 space-y-6 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white font-display">System Health</h1>
          <p className="text-slate-400 text-sm mt-0.5">
            Service-level checks over HTTP/DB/MQTT — not container-level (no Docker socket access; see docs/INTEGRATION_GUIDE.md)
          </p>
        </div>
        <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border ${
          status === 'healthy' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-amber-500/10 text-amber-400 border-amber-500/20'
        }`}>
          {status === 'healthy' ? <CheckCircle className="w-3.5 h-3.5" /> : <AlertTriangle className="w-3.5 h-3.5" />}
          {status?.toUpperCase()}
        </span>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
        {Object.entries(services).map(([id, info]) => <ServiceCard key={id} id={id} info={info} />)}
      </div>

      <div className="card-glow p-5">
        <div className="flex items-center gap-2 mb-4">
          <HardDriveDownload className="w-4 h-4 text-slate-400" />
          <h3 className="font-semibold text-white">Database Backups</h3>
        </div>
        {!backups.length ? (
          <div className="text-center py-6 text-slate-500 text-sm">
            No backups recorded yet. Set up <code className="text-slate-400">scripts/backup.sh</code> via cron — see docs/INTEGRATION_GUIDE.md §11.
          </div>
        ) : (
          <div className="space-y-2">
            {backups.map(b => (
              <div key={b.database_name} className="flex items-center justify-between text-sm p-3 rounded-lg bg-slate-800/40">
                <div className="flex items-center gap-2">
                  {b.status === 'success' ? <CheckCircle className="w-4 h-4 text-emerald-400" /> : <XCircle className="w-4 h-4 text-red-400" />}
                  <span className="text-white font-medium">{b.database_name}</span>
                  {b.overdue && (
                    <span className="text-xs px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20">Overdue</span>
                  )}
                </div>
                <div className="text-right text-xs text-slate-500">
                  <p>{formatDistanceToNow(new Date(b.created_at), { addSuffix: true })}</p>
                  {b.file_size_bytes && <p>{(b.file_size_bytes / 1024 / 1024).toFixed(2)} MB</p>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
