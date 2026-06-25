'use client';
import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { settingsAPI } from '../../../lib/api';
import { Settings, Save, Eye, EyeOff, CheckCircle, Loader2, Server, Mail, MessageSquare, Bot, Cpu } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuthStore } from '../../../store/authStore';

const SECTIONS = [
  {
    id: 'chirpstack',
    icon: Server,
    label: 'ChirpStack Integration',
    color: 'text-blue-400',
    keys: ['chirpstack_url', 'chirpstack_api_key', 'chirpstack_tenant_id']
  },
  {
    id: 'email',
    icon: Mail,
    label: 'Email (SMTP)',
    color: 'text-emerald-400',
    keys: ['email_smtp_host', 'email_smtp_port', 'email_username', 'email_password']
  },
  {
    id: 'telegram',
    icon: MessageSquare,
    label: 'Telegram',
    color: 'text-cyan-400',
    keys: ['telegram_bot_token']
  },
  {
    id: 'whatsapp',
    icon: MessageSquare,
    label: 'WhatsApp',
    color: 'text-green-400',
    keys: ['whatsapp_api_url', 'whatsapp_api_key']
  },
  {
    id: 'ai',
    icon: Bot,
    label: 'AI / Anthropic',
    color: 'text-purple-400',
    keys: ['anthropic_api_key']
  },
  {
    id: 'thresholds',
    icon: Cpu,
    label: 'Thresholds',
    color: 'text-amber-400',
    keys: ['low_battery_threshold', 'leak_detection_threshold', 'consumption_alert_multiplier']
  }
];

const LABELS = {
  chirpstack_url: 'ChirpStack URL',
  chirpstack_api_key: 'API Key',
  chirpstack_tenant_id: 'Tenant ID',
  email_smtp_host: 'SMTP Host',
  email_smtp_port: 'SMTP Port',
  email_username: 'Email Username',
  email_password: 'Email Password',
  telegram_bot_token: 'Bot Token',
  whatsapp_api_url: 'API URL',
  whatsapp_api_key: 'API Key',
  anthropic_api_key: 'Anthropic API Key',
  low_battery_threshold: 'Low Battery Voltage (V)',
  leak_detection_threshold: 'Leak Flow Threshold (L/h)',
  consumption_alert_multiplier: 'Alert Multiplier (x avg)',
};

const SENSITIVE = ['chirpstack_api_key', 'email_password', 'telegram_bot_token', 'whatsapp_api_key', 'anthropic_api_key'];

export default function SettingsPage() {
  const { user } = useAuthStore();
  const [values, setValues] = useState({});
  const [showSensitive, setShowSensitive] = useState({});
  const [saving, setSaving] = useState(false);

  const { data: settings, isLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: async () => {
      const res = await settingsAPI.get();
      const map = {};
      res.data.forEach(s => { map[s.key] = s.value || ''; });
      setValues(map);
      return res.data;
    }
  });

  const handleSave = async (keys) => {
    setSaving(true);
    try {
      const toSave = keys.map(k => ({ key: k, value: values[k] || '' }));
      await settingsAPI.updateMany(toSave);
      toast.success('Settings saved successfully');
    } catch (err) {
      toast.error('Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  if (user?.role !== 'admin') {
    return (
      <div className="p-6 text-center text-slate-400">
        <Settings className="w-12 h-12 mx-auto mb-3 opacity-30" />
        <p>Settings are only accessible to administrators</p>
      </div>
    );
  }

  return (
    <div className="p-4 lg:p-6 space-y-6 animate-fade-in">
      <div>
        <h1 className="text-2xl font-bold text-white font-display">System Settings</h1>
        <p className="text-slate-400 text-sm mt-0.5">Configure integrations, thresholds, and notifications</p>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-6 h-6 text-primary-400 animate-spin" />
        </div>
      ) : (
        <div className="space-y-5">
          {SECTIONS.map(section => (
            <div key={section.id} className="card-glow p-5">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <section.icon className={`w-4.5 h-4.5 ${section.color}`} />
                  <h3 className="font-semibold text-white">{section.label}</h3>
                </div>
                <button
                  onClick={() => handleSave(section.keys)}
                  disabled={saving}
                  className="btn-secondary text-xs py-1.5 px-3"
                >
                  {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
                  Save
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {section.keys.map(key => {
                  const isSensitive = SENSITIVE.includes(key);
                  const show = showSensitive[key];
                  const isMasked = isSensitive && values[key] === '***';

                  return (
                    <div key={key}>
                      <label className="block text-xs text-slate-400 mb-1.5 font-medium">
                        {LABELS[key] || key}
                      </label>
                      <div className="relative">
                        <input
                          type={isSensitive && !show ? 'password' : 'text'}
                          className="input pr-10"
                          value={values[key] || ''}
                          onChange={e => setValues(v => ({ ...v, [key]: e.target.value }))}
                          placeholder={isMasked ? '(encrypted - enter to update)' : ''}
                        />
                        {isSensitive && (
                          <button
                            type="button"
                            onClick={() => setShowSensitive(s => ({ ...s, [key]: !s[key] }))}
                            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
                          >
                            {show ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
