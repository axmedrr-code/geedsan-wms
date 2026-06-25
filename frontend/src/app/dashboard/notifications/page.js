'use client';
import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { notificationsAPI } from '../../../lib/api';
import { Bell, Mail, MessageSquare, Send, Save, Loader2, History } from 'lucide-react';
import toast from 'react-hot-toast';
import { format } from 'date-fns';

const ALARM_TYPES = [
  { key: 'low_battery', label: 'Low Battery' },
  { key: 'valve_failure', label: 'Valve Failure' },
  { key: 'magnetic_attack', label: 'Magnetic Attack' },
  { key: 'water_leakage', label: 'Water Leakage' },
  { key: 'reverse_flow', label: 'Reverse Flow' },
  { key: 'pipe_burst', label: 'Pipe Burst' },
  { key: 'communication_loss', label: 'Communication Loss' },
];

const CHANNELS = [
  { key: 'email', label: 'Email', icon: Mail, placeholder: 'you@example.com', color: 'text-emerald-400' },
  { key: 'telegram', label: 'Telegram', icon: MessageSquare, placeholder: 'Chat ID (e.g. -100123456)', color: 'text-cyan-400' },
  { key: 'whatsapp', label: 'WhatsApp', icon: Send, placeholder: '+252612345678', color: 'text-green-400' },
];

export default function NotificationsPage() {
  const [channelSettings, setChannelSettings] = useState({});
  const [saving, setSaving] = useState(null);

  const { data: existingSettings } = useQuery({
    queryKey: ['notification-settings'],
    queryFn: () => notificationsAPI.getSettings().then(r => r.data)
  });

  const { data: history } = useQuery({
    queryKey: ['notification-history'],
    queryFn: () => notificationsAPI.getHistory().then(r => r.data)
  });

  useEffect(() => {
    if (existingSettings) {
      const map = {};
      existingSettings.forEach(s => {
        map[s.channel] = {
          recipient: s.recipient,
          is_active: s.is_active,
          enabled_alarms: Array.isArray(s.enabled_alarms) ? s.enabled_alarms : JSON.parse(s.enabled_alarms || '[]')
        };
      });
      setChannelSettings(map);
    }
  }, [existingSettings]);

  const getChannelSetting = (channel) => channelSettings[channel] || {
    recipient: '',
    is_active: false,
    enabled_alarms: ALARM_TYPES.map(a => a.key)
  };

  const updateChannel = (channel, key, value) => {
    setChannelSettings(prev => ({
      ...prev,
      [channel]: { ...getChannelSetting(channel), [key]: value }
    }));
  };

  const toggleAlarm = (channel, alarmKey) => {
    const curr = getChannelSetting(channel);
    const alarms = curr.enabled_alarms || [];
    const next = alarms.includes(alarmKey)
      ? alarms.filter(a => a !== alarmKey)
      : [...alarms, alarmKey];
    updateChannel(channel, 'enabled_alarms', next);
  };

  const saveChannel = async (channel) => {
    setSaving(channel);
    try {
      const setting = getChannelSetting(channel);
      await notificationsAPI.saveSettings({ channel, ...setting });
      toast.success(`${channel} notifications saved`);
    } catch (err) {
      toast.error('Failed to save notification settings');
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="p-4 lg:p-6 space-y-6 animate-fade-in">
      <div>
        <h1 className="text-2xl font-bold text-white font-display">Notifications</h1>
        <p className="text-slate-400 text-sm mt-0.5">Configure alert channels for alarm notifications</p>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {CHANNELS.map(channel => {
          const setting = getChannelSetting(channel.key);
          return (
            <div key={channel.key} className="card-glow p-5 space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <channel.icon className={`w-5 h-5 ${channel.color}`} />
                  <h3 className="font-semibold text-white">{channel.label} Notifications</h3>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    className="sr-only peer"
                    checked={setting.is_active}
                    onChange={e => updateChannel(channel.key, 'is_active', e.target.checked)}
                  />
                  <div className="w-9 h-5 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:bg-primary-500 after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all" />
                </label>
              </div>

              <div>
                <label className="block text-xs text-slate-400 mb-1.5 font-medium">
                  {channel.key === 'email' ? 'Email Address' : channel.key === 'telegram' ? 'Chat ID' : 'Phone Number'}
                </label>
                <input
                  className="input"
                  placeholder={channel.placeholder}
                  value={setting.recipient}
                  onChange={e => updateChannel(channel.key, 'recipient', e.target.value)}
                />
              </div>

              <div>
                <p className="text-xs text-slate-400 font-medium mb-2">Alarm Types</p>
                <div className="grid grid-cols-2 gap-1.5">
                  {ALARM_TYPES.map(alarm => (
                    <label key={alarm.key} className="flex items-center gap-2 cursor-pointer text-xs">
                      <input
                        type="checkbox"
                        checked={(setting.enabled_alarms || []).includes(alarm.key)}
                        onChange={() => toggleAlarm(channel.key, alarm.key)}
                        className="rounded"
                      />
                      <span className="text-slate-400">{alarm.label}</span>
                    </label>
                  ))}
                </div>
              </div>

              <button
                onClick={() => saveChannel(channel.key)}
                disabled={saving === channel.key}
                className="w-full btn-primary justify-center"
              >
                {saving === channel.key ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                Save Settings
              </button>
            </div>
          );
        })}
      </div>

      {/* Notification History */}
      <div className="card-glow p-5">
        <div className="flex items-center gap-2 mb-4">
          <History className="w-4 h-4 text-slate-400" />
          <h3 className="font-semibold text-white">Recent Notifications</h3>
        </div>
        {!history?.length ? (
          <p className="text-slate-500 text-sm text-center py-6">No notifications sent yet</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Channel</th>
                  <th>Recipient</th>
                  <th>Subject</th>
                  <th>Status</th>
                  <th>Sent At</th>
                </tr>
              </thead>
              <tbody>
                {history.slice(0, 20).map(n => (
                  <tr key={n.id}>
                    <td><span className="capitalize text-slate-300">{n.channel}</span></td>
                    <td><span className="text-xs font-mono text-slate-400">{n.recipient}</span></td>
                    <td><span className="text-xs text-slate-400 truncate max-w-xs block">{n.subject || n.alarm_type || '—'}</span></td>
                    <td>
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                        n.status === 'sent' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'
                      }`}>{n.status}</span>
                    </td>
                    <td><span className="text-xs text-slate-500">{n.sent_at ? format(new Date(n.sent_at), 'MM/dd HH:mm') : '—'}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
