'use client';
import { useQuery } from '@tanstack/react-query';
import { gatewaysAPI } from '../../../lib/api';
import { useRealtimeEvents } from '../../../lib/useRealtimeEvents';
import { Wifi, WifiOff, Radio, Signal, Clock, Activity } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

const rssiColor = (r) => {
  if (r === null || r === undefined) return 'text-slate-500';
  if (r < -115) return 'text-red-400';
  if (r < -100) return 'text-orange-400';
  if (r < -85) return 'text-amber-400';
  return 'text-emerald-400';
};

export default function GatewaysPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['gateways'],
    queryFn: () => gatewaysAPI.list().then(r => r.data),
    refetchInterval: 30000
  });

  useRealtimeEvents([['gateways']]);

  const gateways = data?.data || [];
  const onlineCount = gateways.filter(g => g.is_online).length;

  return (
    <div className="p-4 lg:p-6 space-y-5 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white font-display">Gateways</h1>
          <p className="text-slate-400 text-sm mt-0.5">
            {onlineCount} online / {gateways.length} total — gateways self-register from incoming traffic, no manual provisioning required
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
        {isLoading ? (
          Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="card-glow p-5 h-40 animate-pulse" />
          ))
        ) : gateways.length === 0 ? (
          <div className="col-span-full card-glow p-12 text-center text-slate-500">
            <Radio className="w-10 h-10 mx-auto mb-2 opacity-30" />
            <p>No gateways have reported traffic yet</p>
            <p className="text-xs mt-1">Gateways appear here automatically once a device uplink is received via MQTT or the ChirpStack webhook.</p>
          </div>
        ) : (
          gateways.map(gw => (
            <div key={gw.id} className="card-glow p-5">
              <div className="flex items-start justify-between mb-3">
                <div>
                  <p className="font-mono text-sm text-primary-400">{gw.gateway_eui}</p>
                  <p className="text-white font-semibold mt-0.5">{gw.name || 'Unnamed gateway'}</p>
                </div>
                {gw.is_online ? (
                  <span className="badge-online">
                    <span className="pulse-dot" /> Online
                  </span>
                ) : (
                  <span className="badge-offline">
                    <WifiOff className="w-3 h-3" /> Offline
                  </span>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3 text-xs">
                <div className="flex items-center gap-1.5 text-slate-400">
                  <Signal className={`w-3.5 h-3.5 ${rssiColor(gw.last_rssi)}`} />
                  <span className={rssiColor(gw.last_rssi)}>{gw.last_rssi ? `${gw.last_rssi} dBm` : '—'}</span>
                </div>
                <div className="flex items-center gap-1.5 text-slate-400">
                  <Activity className="w-3.5 h-3.5" />
                  <span>SNR {gw.last_snr ?? '—'}</span>
                </div>
                <div className="flex items-center gap-1.5 text-slate-400 col-span-2">
                  <Clock className="w-3.5 h-3.5" />
                  <span>{gw.last_seen ? formatDistanceToNow(new Date(gw.last_seen), { addSuffix: true }) : 'Never'}</span>
                </div>
              </div>

              <div className="mt-4 pt-3 border-t border-slate-800 flex items-center justify-between text-xs">
                <span className="text-slate-500">Uplinks (total)</span>
                <span className="text-white font-mono">{gw.uplink_count}</span>
              </div>
              <div className="flex items-center justify-between text-xs mt-1">
                <span className="text-slate-500">Uplinks (24h)</span>
                <span className="text-white font-mono">{gw.readings_24h}</span>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
