'use client';

import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { settingsAPI, systemAPI } from '../../../lib/api';
import { useAuthStore } from '../../../store/authStore';
import toast from 'react-hot-toast';
import {
  Settings, Save, Loader2, AlertTriangle, RefreshCw,
  Server, Mail, Bell, Shield, Database, Zap, Droplets,
  Activity, Users, CheckCircle, XCircle, Eye, EyeOff,
  Download, CreditCard, Cpu, Info,
} from 'lucide-react';

// ─── style constants ──────────────────────────────────────────────────────────
const INPUT  = 'w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500 disabled:opacity-50 disabled:cursor-not-allowed';
const BTN_P  = 'flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded-lg disabled:opacity-50 transition-colors';
const BTN_S  = 'flex items-center gap-2 px-4 py-2 bg-slate-700 hover:bg-slate-600 text-slate-300 text-sm rounded-lg transition-colors';
const CARD   = 'bg-slate-900/50 border border-slate-800 rounded-2xl p-6';

// ─── tiny reusable atoms ──────────────────────────────────────────────────────

function Toggle({ checked, onChange, disabled }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      className={`relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed ${checked ? 'bg-emerald-600' : 'bg-slate-700'}`}
    >
      <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-[18px]' : 'translate-x-[2px]'}`} />
    </button>
  );
}

function PwdInput({ value, onChange, disabled, placeholder }) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <input
        type={show ? 'text' : 'password'}
        className={`${INPUT} pr-9`}
        value={value}
        onChange={onChange}
        disabled={disabled}
        placeholder={placeholder}
      />
      <button
        type="button"
        tabIndex={-1}
        onClick={() => setShow(s => !s)}
        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
      >
        {show ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
      </button>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <label className="block text-xs text-slate-400 mb-1.5 font-medium">{label}</label>
      {children}
    </div>
  );
}

function SectionTitle({ title, desc }) {
  return (
    <div className="mb-6">
      <h2 className="text-lg font-semibold text-white">{title}</h2>
      {desc && <p className="text-sm text-slate-400 mt-0.5">{desc}</p>}
    </div>
  );
}

function SaveBtn({ onClick, disabled, pending }) {
  return (
    <button onClick={onClick} disabled={disabled} className={BTN_P}>
      {pending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
      Save Changes
    </button>
  );
}

function StatusBadge({ ok }) {
  return ok
    ? <span className="flex items-center gap-1 text-xs text-emerald-400"><CheckCircle className="w-3.5 h-3.5" />Healthy</span>
    : <span className="flex items-center gap-1 text-xs text-red-400"><XCircle className="w-3.5 h-3.5" />Offline</span>;
}

function InfoNote({ children }) {
  return (
    <div className="flex items-start gap-2 p-3 bg-blue-900/20 border border-blue-800/50 rounded-lg text-xs text-blue-300">
      <Info className="w-4 h-4 flex-shrink-0 mt-0.5" />
      <span>{children}</span>
    </div>
  );
}

function ToggleRow({ label, desc, checked, onChange, disabled }) {
  return (
    <div className="flex items-center justify-between">
      <div>
        <p className="text-sm text-white font-medium">{label}</p>
        {desc && <p className="text-xs text-slate-400">{desc}</p>}
      </div>
      <Toggle checked={checked} onChange={onChange} disabled={disabled} />
    </div>
  );
}

// bool / num helpers for settings map (values come as strings from API)
const bv = (v, def = false) => v !== undefined ? (v === 'true' || v === true) : def;
const nv = (v, def = 0)     => v !== undefined ? Number(v) : def;
const sv = (v, def = '')    => v !== undefined ? String(v) : def;

// ─── Section: General ─────────────────────────────────────────────────────────

function GeneralSection({ sm, canEdit }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    company_name: '', company_logo_url: '',
    timezone: 'Africa/Mogadishu', currency: 'USD',
    date_format: 'DD MMM YYYY', language: 'en',
  });

  useEffect(() => {
    if (!sm || !Object.keys(sm).length) return;
    setForm(f => ({
      company_name:     sv(sm.company_name,     f.company_name),
      company_logo_url: sv(sm.company_logo_url, f.company_logo_url),
      timezone:         sv(sm.timezone,         f.timezone),
      currency:         sv(sm.currency,         f.currency),
      date_format:      sv(sm.date_format,      f.date_format),
      language:         sv(sm.language,         f.language),
    }));
  }, [sm]);

  const mut = useMutation({
    mutationFn: d => settingsAPI.updateMany(d),
    onSuccess: () => { toast.success('Settings saved'); qc.invalidateQueries({ queryKey: ['settings'] }); },
    onError: e => toast.error(e?.response?.data?.error || 'Failed to save'),
  });

  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));

  return (
    <div>
      <SectionTitle title="General Settings" desc="Basic company information and locale" />
      <div className={`${CARD} space-y-4`}>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Company Name">
            <input className={INPUT} disabled={!canEdit} value={form.company_name} onChange={set('company_name')} placeholder="e.g. NUWACO" />
          </Field>
          <Field label="Company Logo URL">
            <input className={INPUT} disabled={!canEdit} value={form.company_logo_url} onChange={set('company_logo_url')} placeholder="https://..." />
          </Field>
          <Field label="Timezone">
            <select className={INPUT} disabled={!canEdit} value={form.timezone} onChange={set('timezone')}>
              {['Africa/Mogadishu','UTC','Africa/Nairobi','Asia/Dubai','Europe/London','America/New_York'].map(z => (
                <option key={z} value={z}>{z}</option>
              ))}
            </select>
          </Field>
          <Field label="Currency">
            <select className={INPUT} disabled={!canEdit} value={form.currency} onChange={set('currency')}>
              {['USD','EUR','GBP','KES','SOS'].map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
          <Field label="Date Format">
            <select className={INPUT} disabled={!canEdit} value={form.date_format} onChange={set('date_format')}>
              <option value="DD MMM YYYY">DD MMM YYYY</option>
              <option value="MM/DD/YYYY">MM/DD/YYYY</option>
              <option value="YYYY-MM-DD">YYYY-MM-DD</option>
            </select>
          </Field>
          <Field label="Language">
            <select className={INPUT} disabled={!canEdit} value={form.language} onChange={set('language')}>
              <option value="en">English</option>
              <option value="so">Somali</option>
              <option value="ar">Arabic</option>
            </select>
          </Field>
        </div>
        {canEdit && (
          <SaveBtn
            onClick={() => mut.mutate(Object.entries(form).map(([key, value]) => ({ key, value: value || '' })))}
            disabled={mut.isPending}
            pending={mut.isPending}
          />
        )}
      </div>
    </div>
  );
}

// ─── Section: Billing ─────────────────────────────────────────────────────────

function BillingSection({ data, canEdit }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    billing_cycle: 'monthly', due_days: 30,
    default_tariff: 'residential', currency: 'USD',
    auto_post_invoice: false, auto_sync_odoo: false,
  });

  useEffect(() => { if (data) setForm({ ...data }); }, [data]);

  const mut = useMutation({
    mutationFn: d => settingsAPI.updateBilling(d),
    onSuccess: () => { toast.success('Billing settings saved'); qc.invalidateQueries({ queryKey: ['billingSettings'] }); },
    onError: e => toast.error(e?.response?.data?.error || 'Failed to save'),
  });

  const set  = k => e => setForm(f => ({ ...f, [k]: e.target.value }));
  const setn = k => e => setForm(f => ({ ...f, [k]: Number(e.target.value) }));
  const sett = k => v  => setForm(f => ({ ...f, [k]: v }));

  return (
    <div>
      <SectionTitle title="Billing Settings" desc="Billing cycles, due dates, and invoice automation" />
      <div className={`${CARD} space-y-4`}>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Billing Cycle">
            <select className={INPUT} disabled={!canEdit} value={form.billing_cycle} onChange={set('billing_cycle')}>
              <option value="monthly">Monthly</option>
              <option value="weekly">Weekly</option>
              <option value="custom">Custom</option>
            </select>
          </Field>
          <Field label="Due Days (after invoice date)">
            <input type="number" className={INPUT} disabled={!canEdit} value={form.due_days} onChange={setn('due_days')} min={0} />
          </Field>
          <Field label="Default Tariff">
            <select className={INPUT} disabled={!canEdit} value={form.default_tariff} onChange={set('default_tariff')}>
              <option value="residential">Residential</option>
              <option value="commercial">Commercial</option>
              <option value="industrial">Industrial</option>
              <option value="government">Government</option>
            </select>
          </Field>
          <Field label="Currency">
            <select className={INPUT} disabled={!canEdit} value={form.currency} onChange={set('currency')}>
              {['USD','EUR','GBP','KES','SOS'].map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
        </div>
        <div className="space-y-3 pt-2 border-t border-slate-800">
          <ToggleRow label="Auto-Post Invoice" desc="Automatically post invoices to Odoo after creation" checked={!!form.auto_post_invoice} onChange={sett('auto_post_invoice')} disabled={!canEdit} />
          <ToggleRow label="Auto Sync to Odoo" desc="Automatically sync billing data to Odoo" checked={!!form.auto_sync_odoo} onChange={sett('auto_sync_odoo')} disabled={!canEdit} />
        </div>
        {canEdit && <SaveBtn onClick={() => mut.mutate(form)} disabled={mut.isPending} pending={mut.isPending} />}
      </div>
    </div>
  );
}

// ─── Section: Notifications ───────────────────────────────────────────────────

const PWD_KEYS = ['email_password','telegram_bot_token','whatsapp_api_key','anthropic_api_key'];

function NotificationsSection({ sm, canEdit }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    email_enabled: false, whatsapp_enabled: false, telegram_enabled: false,
    sms_enabled: false, push_enabled: false,
    email_smtp_host: '', email_smtp_port: '', email_username: '', email_password: '',
    telegram_bot_token: '', whatsapp_api_url: '', whatsapp_api_key: '', anthropic_api_key: '',
  });
  const [testResult, setTestResult] = useState(null);

  useEffect(() => {
    if (!sm || !Object.keys(sm).length) return;
    setForm(f => ({
      email_enabled:     bv(sm.email_enabled),
      whatsapp_enabled:  bv(sm.whatsapp_enabled),
      telegram_enabled:  bv(sm.telegram_enabled),
      sms_enabled:       bv(sm.sms_enabled),
      push_enabled:      bv(sm.push_enabled),
      email_smtp_host:   sv(sm.email_smtp_host,   f.email_smtp_host),
      email_smtp_port:   sv(sm.email_smtp_port,   f.email_smtp_port),
      email_username:    sv(sm.email_username,    f.email_username),
      email_password:    sv(sm.email_password,    f.email_password),
      telegram_bot_token:sv(sm.telegram_bot_token,f.telegram_bot_token),
      whatsapp_api_url:  sv(sm.whatsapp_api_url,  f.whatsapp_api_url),
      whatsapp_api_key:  sv(sm.whatsapp_api_key,  f.whatsapp_api_key),
      anthropic_api_key: sv(sm.anthropic_api_key, f.anthropic_api_key),
    }));
  }, [sm]);

  const mut = useMutation({
    mutationFn: d => settingsAPI.updateMany(d),
    onSuccess: () => { toast.success('Notification settings saved'); qc.invalidateQueries({ queryKey: ['settings'] }); },
    onError: e => toast.error(e?.response?.data?.error || 'Failed to save'),
  });

  const testMut = useMutation({
    mutationFn: () => settingsAPI.testEmail(),
    onSuccess: r  => setTestResult({ ok: r.data.success, msg: r.data.message }),
    onError:   e  => setTestResult({ ok: false, msg: e?.response?.data?.error || 'Test failed' }),
  });

  const set  = k => e => setForm(f => ({ ...f, [k]: e.target.value }));
  const sett = k => v  => setForm(f => ({ ...f, [k]: v }));

  const handleSave = () => {
    const plain = ['email_enabled','whatsapp_enabled','telegram_enabled','sms_enabled','push_enabled','email_smtp_host','email_smtp_port','email_username','whatsapp_api_url'];
    const payload = plain.map(k => ({ key: k, value: String(form[k] ?? '') }));
    // only send password fields if user actually changed them from the masked placeholder
    for (const k of PWD_KEYS) {
      const v = form[k];
      if (v && v !== '***') payload.push({ key: k, value: v });
    }
    mut.mutate(payload);
  };

  const pwdPlaceholder = k => form[k] === '***' ? '(saved — enter to update)' : '';

  return (
    <div>
      <SectionTitle title="Notifications" desc="Configure notification channels and credentials" />

      {/* Channel toggles */}
      <div className={`${CARD} mb-4`}>
        <h3 className="text-sm font-medium text-white mb-4">Notification Channels</h3>
        <div className="space-y-3">
          {[
            { k:'email_enabled',     label:'Email',              desc:'Send alerts via email' },
            { k:'whatsapp_enabled',  label:'WhatsApp',           desc:'Send via WhatsApp Business API' },
            { k:'telegram_enabled',  label:'Telegram',           desc:'Send via Telegram bot' },
            { k:'sms_enabled',       label:'SMS',                desc:'Send notifications via SMS' },
            { k:'push_enabled',      label:'Push Notifications', desc:'Browser and mobile push' },
          ].map(({ k, label, desc }) => (
            <ToggleRow key={k} label={label} desc={desc} checked={!!form[k]} onChange={sett(k)} disabled={!canEdit} />
          ))}
        </div>
      </div>

      {/* SMTP */}
      <div className={`${CARD} mb-4`}>
        <h3 className="text-sm font-medium text-white mb-4">SMTP Configuration</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="SMTP Host">
            <input className={INPUT} disabled={!canEdit} value={form.email_smtp_host} onChange={set('email_smtp_host')} placeholder="smtp.gmail.com" />
          </Field>
          <Field label="SMTP Port">
            <input className={INPUT} disabled={!canEdit} value={form.email_smtp_port} onChange={set('email_smtp_port')} placeholder="587" />
          </Field>
          <Field label="Email Username">
            <input className={INPUT} disabled={!canEdit} value={form.email_username} onChange={set('email_username')} placeholder="alerts@company.com" />
          </Field>
          <Field label="Email Password">
            <PwdInput value={form.email_password} onChange={set('email_password')} disabled={!canEdit} placeholder={pwdPlaceholder('email_password')} />
          </Field>
        </div>
        <div className="flex items-center gap-3 mt-4">
          <button onClick={() => testMut.mutate()} disabled={testMut.isPending} className={BTN_S}>
            {testMut.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mail className="w-4 h-4" />}
            Test Email
          </button>
          {testResult && (
            testResult.ok
              ? <span className="flex items-center gap-1 text-sm text-emerald-400"><CheckCircle className="w-4 h-4" />{testResult.msg}</span>
              : <span className="flex items-center gap-1 text-sm text-red-400"><XCircle className="w-4 h-4" />{testResult.msg}</span>
          )}
        </div>
      </div>

      {/* Messaging credentials */}
      <div className={`${CARD} mb-4`}>
        <h3 className="text-sm font-medium text-white mb-4">Messaging Credentials</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Telegram Bot Token">
            <PwdInput value={form.telegram_bot_token} onChange={set('telegram_bot_token')} disabled={!canEdit} placeholder={pwdPlaceholder('telegram_bot_token')} />
          </Field>
          <Field label="WhatsApp API URL">
            <input className={INPUT} disabled={!canEdit} value={form.whatsapp_api_url} onChange={set('whatsapp_api_url')} placeholder="https://api.whatsapp.com/v1" />
          </Field>
          <Field label="WhatsApp API Key">
            <PwdInput value={form.whatsapp_api_key} onChange={set('whatsapp_api_key')} disabled={!canEdit} placeholder={pwdPlaceholder('whatsapp_api_key')} />
          </Field>
          <Field label="Anthropic API Key (AI)">
            <PwdInput value={form.anthropic_api_key} onChange={set('anthropic_api_key')} disabled={!canEdit} placeholder={pwdPlaceholder('anthropic_api_key')} />
          </Field>
        </div>
      </div>

      {canEdit && <SaveBtn onClick={handleSave} disabled={mut.isPending} pending={mut.isPending} />}
    </div>
  );
}

// ─── Section: Security ────────────────────────────────────────────────────────

function SecuritySection({ sm, canEdit }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    session_timeout_minutes: 60, password_min_length: 8,
    max_login_attempts: 5, password_expiry_days: 90,
    two_factor_enabled: false, audit_logging_enabled: true, force_https: false,
  });

  useEffect(() => {
    if (!sm || !Object.keys(sm).length) return;
    setForm(f => ({
      session_timeout_minutes: nv(sm.session_timeout_minutes, f.session_timeout_minutes),
      password_min_length:     nv(sm.password_min_length,     f.password_min_length),
      max_login_attempts:      nv(sm.max_login_attempts,      f.max_login_attempts),
      password_expiry_days:    nv(sm.password_expiry_days,    f.password_expiry_days),
      two_factor_enabled:      bv(sm.two_factor_enabled,      false),
      audit_logging_enabled:   sm.audit_logging_enabled !== undefined ? bv(sm.audit_logging_enabled) : true,
      force_https:             bv(sm.force_https,             false),
    }));
  }, [sm]);

  const mut = useMutation({
    mutationFn: d => settingsAPI.updateMany(d),
    onSuccess: () => { toast.success('Security settings saved'); qc.invalidateQueries({ queryKey: ['settings'] }); },
    onError: e => toast.error(e?.response?.data?.error || 'Failed to save'),
  });

  const setn = k => e => setForm(f => ({ ...f, [k]: Number(e.target.value) }));
  const sett = k => v  => setForm(f => ({ ...f, [k]: v }));

  const handleSave = () => {
    mut.mutate([
      { key: 'session_timeout_minutes', value: String(form.session_timeout_minutes) },
      { key: 'password_min_length',     value: String(form.password_min_length) },
      { key: 'max_login_attempts',      value: String(form.max_login_attempts) },
      { key: 'password_expiry_days',    value: String(form.password_expiry_days) },
      { key: 'two_factor_enabled',      value: String(form.two_factor_enabled) },
      { key: 'audit_logging_enabled',   value: String(form.audit_logging_enabled) },
      { key: 'force_https',             value: String(form.force_https) },
    ]);
  };

  return (
    <div>
      <SectionTitle title="Security Settings" desc="Authentication and access control configuration" />
      <div className={`${CARD} space-y-4`}>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Session Timeout (minutes)">
            <input type="number" className={INPUT} disabled={!canEdit} value={form.session_timeout_minutes} onChange={setn('session_timeout_minutes')} min={5} />
          </Field>
          <Field label="Minimum Password Length">
            <input type="number" className={INPUT} disabled={!canEdit} value={form.password_min_length} onChange={setn('password_min_length')} min={6} max={32} />
          </Field>
          <Field label="Max Login Attempts">
            <input type="number" className={INPUT} disabled={!canEdit} value={form.max_login_attempts} onChange={setn('max_login_attempts')} min={1} />
          </Field>
          <Field label="Password Expiry (days, 0 = never)">
            <input type="number" className={INPUT} disabled={!canEdit} value={form.password_expiry_days} onChange={setn('password_expiry_days')} min={0} />
          </Field>
        </div>
        <div className="space-y-3 pt-2 border-t border-slate-800">
          <ToggleRow label="Two-Factor Authentication" desc="Require 2FA for all users" checked={form.two_factor_enabled} onChange={sett('two_factor_enabled')} disabled={!canEdit} />
          <ToggleRow label="Audit Logging" desc="Log all user actions for compliance" checked={form.audit_logging_enabled} onChange={sett('audit_logging_enabled')} disabled={!canEdit} />
          <ToggleRow label="Force HTTPS" desc="Redirect all HTTP traffic to HTTPS" checked={form.force_https} onChange={sett('force_https')} disabled={!canEdit} />
        </div>
        <InfoNote>Two-factor authentication and HTTPS enforcement require additional server configuration.</InfoNote>
        {canEdit && <SaveBtn onClick={handleSave} disabled={mut.isPending} pending={mut.isPending} />}
      </div>
    </div>
  );
}

// ─── Section: Backup ──────────────────────────────────────────────────────────

function BackupSection({ sm, canEdit, userRole }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    backup_enabled: false, backup_schedule: 'daily',
    backup_time: '02:00', backup_retention_days: 30, backup_location: '',
  });
  const [backupResult, setBackupResult] = useState(null);

  useEffect(() => {
    if (!sm || !Object.keys(sm).length) return;
    setForm(f => ({
      backup_enabled:        bv(sm.backup_enabled),
      backup_schedule:       sv(sm.backup_schedule, f.backup_schedule),
      backup_time:           sv(sm.backup_time,     f.backup_time),
      backup_retention_days: nv(sm.backup_retention_days, f.backup_retention_days),
      backup_location:       sv(sm.backup_location, f.backup_location),
    }));
  }, [sm]);

  const mut = useMutation({
    mutationFn: d => settingsAPI.updateMany(d),
    onSuccess: () => { toast.success('Backup settings saved'); qc.invalidateQueries({ queryKey: ['settings'] }); },
    onError: e => toast.error(e?.response?.data?.error || 'Failed to save'),
  });

  const backupMut = useMutation({
    mutationFn: () => settingsAPI.triggerBackup(),
    onSuccess: r => setBackupResult({ ok: r.data.success, msg: r.data.message, file: r.data.file, size: r.data.size_bytes }),
    onError:   e => setBackupResult({ ok: false, msg: e?.response?.data?.error || 'Backup failed' }),
  });

  const set  = k => e => setForm(f => ({ ...f, [k]: e.target.value }));
  const setn = k => e => setForm(f => ({ ...f, [k]: Number(e.target.value) }));
  const sett = k => v  => setForm(f => ({ ...f, [k]: v }));
  const fmtB = b => b > 1e6 ? `${(b/1e6).toFixed(1)} MB` : `${(b/1e3).toFixed(0)} KB`;
  const isAdminOnly = userRole !== 'admin';

  const handleSave = () => {
    mut.mutate([
      { key: 'backup_enabled',        value: String(form.backup_enabled) },
      { key: 'backup_schedule',       value: form.backup_schedule },
      { key: 'backup_time',           value: form.backup_time },
      { key: 'backup_retention_days', value: String(form.backup_retention_days) },
      { key: 'backup_location',       value: form.backup_location },
    ]);
  };

  return (
    <div>
      <SectionTitle title="Backup" desc="Automated and manual database backup configuration" />
      <div className={`${CARD} mb-4 space-y-4`}>
        <ToggleRow label="Enable Automated Backups" desc="Schedule regular database backups" checked={form.backup_enabled} onChange={sett('backup_enabled')} disabled={!canEdit} />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2 border-t border-slate-800">
          <Field label="Backup Schedule">
            <select className={INPUT} disabled={!canEdit} value={form.backup_schedule} onChange={set('backup_schedule')}>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
            </select>
          </Field>
          <Field label="Backup Time">
            <input type="time" className={INPUT} disabled={!canEdit} value={form.backup_time} onChange={set('backup_time')} />
          </Field>
          <Field label="Retention (days)">
            <input type="number" className={INPUT} disabled={!canEdit} value={form.backup_retention_days} onChange={setn('backup_retention_days')} min={1} />
          </Field>
          <Field label="Backup Location">
            <input className={INPUT} disabled={!canEdit} value={form.backup_location} onChange={set('backup_location')} placeholder="/backups or s3://bucket/path" />
          </Field>
        </div>
        {canEdit && <SaveBtn onClick={handleSave} disabled={mut.isPending} pending={mut.isPending} />}
      </div>

      <div className={CARD}>
        <h3 className="text-sm font-medium text-white mb-3">Manual Backup</h3>
        <div className="flex items-center gap-3">
          <button
            onClick={() => !isAdminOnly && backupMut.mutate()}
            disabled={backupMut.isPending || isAdminOnly}
            title={isAdminOnly ? 'Admin only' : 'Trigger backup now'}
            className={BTN_P}
          >
            {backupMut.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
            Backup Now
          </button>
          {isAdminOnly && <span className="text-xs text-amber-400">Admin only</span>}
        </div>
        {backupResult && (
          <div className={`mt-3 p-3 rounded-lg text-sm ${backupResult.ok ? 'bg-emerald-900/20 border border-emerald-800/50 text-emerald-300' : 'bg-red-900/20 border border-red-800/50 text-red-300'}`}>
            <p className="font-medium">{backupResult.msg}</p>
            {backupResult.ok && backupResult.file && (
              <p className="text-xs mt-1 opacity-75">File: {backupResult.file}{backupResult.size ? ` (${fmtB(backupResult.size)})` : ''}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Section: Odoo Integration ────────────────────────────────────────────────

function OdooSection({ health }) {
  const [testResult, setTestResult] = useState(null);

  const testMut = useMutation({
    mutationFn: () => settingsAPI.testOdoo(),
    onSuccess: r => setTestResult({ ok: r.data.success, msg: r.data.message }),
    onError:   e => setTestResult({ ok: false, msg: e?.response?.data?.error || 'Connection failed' }),
  });

  const odoo = health?.services?.odoo;

  return (
    <div>
      <SectionTitle title="Odoo Integration" desc="ERP synchronization and connection status" />

      <div className={`${CARD} mb-4`}>
        <h3 className="text-sm font-medium text-white mb-3">Connection Status</h3>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <div className="bg-slate-800/50 rounded-xl p-4">
            <p className="text-xs text-slate-400 mb-2">Status</p>
            <StatusBadge ok={odoo?.status === 'healthy'} />
          </div>
          {odoo?.latencyMs !== undefined && (
            <div className="bg-slate-800/50 rounded-xl p-4">
              <p className="text-xs text-slate-400 mb-2">Latency</p>
              <p className="text-sm font-mono text-white">{odoo.latencyMs} ms</p>
            </div>
          )}
        </div>
      </div>

      <div className={CARD}>
        <h3 className="text-sm font-medium text-white mb-3">Actions</h3>
        <div className="flex items-center gap-3">
          <button onClick={() => testMut.mutate()} disabled={testMut.isPending} className={BTN_S}>
            {testMut.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
            Test Connection
          </button>
        </div>
        {testResult && (
          <div className={`mt-3 flex items-center gap-2 text-sm ${testResult.ok ? 'text-emerald-400' : 'text-red-400'}`}>
            {testResult.ok ? <CheckCircle className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
            {testResult.msg}
          </div>
        )}
        <div className="mt-4">
          <InfoNote>
            Odoo credentials are managed via docker-compose environment variables. Use the{' '}
            <a href="/dashboard/odoo" className="text-blue-400 hover:underline">Odoo Status page</a>{' '}
            to process the sync queue.
          </InfoNote>
        </div>
      </div>
    </div>
  );
}

// ─── Section: ChirpStack ──────────────────────────────────────────────────────

function ChirpStackSection({ sm, health }) {
  const [testResult, setTestResult] = useState(null);

  const testMut = useMutation({
    mutationFn: () => settingsAPI.testChirpStack(),
    onSuccess: r => setTestResult({ ok: r.data.success, msg: r.data.message }),
    onError:   e => setTestResult({ ok: false, msg: e?.response?.data?.error || 'Connection failed' }),
  });

  const cs    = health?.services?.chirpstack;
  const csUrl = sm?.chirpstack_url || '(not configured)';
  const csKey = sm?.chirpstack_api_key;

  return (
    <div>
      <SectionTitle title="ChirpStack Integration" desc="LoRaWAN network server connection" />

      <div className={`${CARD} mb-4`}>
        <h3 className="text-sm font-medium text-white mb-3">Configuration (read-only)</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <p className="text-xs text-slate-400 mb-1">Server URL</p>
            <p className="text-sm font-mono text-white bg-slate-800/50 rounded-lg px-3 py-2 break-all">{csUrl}</p>
          </div>
          <div>
            <p className="text-xs text-slate-400 mb-1">API Key</p>
            <p className="text-sm font-mono text-slate-400 bg-slate-800/50 rounded-lg px-3 py-2">
              {csKey === '***' ? '••••••••••••••••' : csKey ? '(set)' : '(not set)'}
            </p>
          </div>
        </div>
      </div>

      <div className={`${CARD} mb-4`}>
        <h3 className="text-sm font-medium text-white mb-3">Connection Status</h3>
        <div className="grid grid-cols-2 gap-3 mb-4">
          <div className="bg-slate-800/50 rounded-xl p-4">
            <p className="text-xs text-slate-400 mb-2">Status</p>
            <StatusBadge ok={cs?.status === 'healthy'} />
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={() => testMut.mutate()} disabled={testMut.isPending} className={BTN_S}>
            {testMut.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Server className="w-4 h-4" />}
            Test Connection
          </button>
        </div>
        {testResult && (
          <div className={`mt-3 flex items-center gap-2 text-sm ${testResult.ok ? 'text-emerald-400' : 'text-red-400'}`}>
            {testResult.ok ? <CheckCircle className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
            {testResult.msg}
          </div>
        )}
        <div className="mt-4">
          <InfoNote>ChirpStack credentials are managed via docker-compose environment variables.</InfoNote>
        </div>
      </div>
    </div>
  );
}

// ─── Section: AI Settings ─────────────────────────────────────────────────────

function AISettingsSection({ sm, canEdit }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    ai_forecast_enabled: false, leak_detection_enabled: false, abnormal_detection_enabled: false,
    forecast_horizon_days: 7, ai_confidence_threshold: 0.8, leak_sensitivity: 0.7,
  });

  useEffect(() => {
    if (!sm || !Object.keys(sm).length) return;
    setForm(f => ({
      ai_forecast_enabled:       bv(sm.ai_forecast_enabled),
      leak_detection_enabled:    bv(sm.leak_detection_enabled),
      abnormal_detection_enabled:bv(sm.abnormal_detection_enabled),
      forecast_horizon_days:     nv(sm.forecast_horizon_days,     f.forecast_horizon_days),
      ai_confidence_threshold:   nv(sm.ai_confidence_threshold,   f.ai_confidence_threshold),
      leak_sensitivity:          nv(sm.leak_sensitivity,          f.leak_sensitivity),
    }));
  }, [sm]);

  const mut = useMutation({
    mutationFn: d => settingsAPI.updateMany(d),
    onSuccess: () => { toast.success('AI settings saved'); qc.invalidateQueries({ queryKey: ['settings'] }); },
    onError: e => toast.error(e?.response?.data?.error || 'Failed to save'),
  });

  const setn = k => e => setForm(f => ({ ...f, [k]: Number(e.target.value) }));
  const sett = k => v  => setForm(f => ({ ...f, [k]: v }));

  const handleSave = () => {
    mut.mutate([
      { key: 'ai_forecast_enabled',        value: String(form.ai_forecast_enabled) },
      { key: 'leak_detection_enabled',     value: String(form.leak_detection_enabled) },
      { key: 'abnormal_detection_enabled', value: String(form.abnormal_detection_enabled) },
      { key: 'forecast_horizon_days',      value: String(form.forecast_horizon_days) },
      { key: 'ai_confidence_threshold',    value: String(form.ai_confidence_threshold) },
      { key: 'leak_sensitivity',           value: String(form.leak_sensitivity) },
    ]);
  };

  return (
    <div>
      <SectionTitle title="AI Settings" desc="Machine learning and anomaly detection configuration" />
      <div className={`${CARD} space-y-4`}>
        <div className="space-y-3">
          <ToggleRow label="Demand Forecasting"           desc="Predict future water consumption using AI"  checked={form.ai_forecast_enabled}        onChange={sett('ai_forecast_enabled')}        disabled={!canEdit} />
          <ToggleRow label="Leak Detection"               desc="Automatically detect potential leaks"        checked={form.leak_detection_enabled}      onChange={sett('leak_detection_enabled')}     disabled={!canEdit} />
          <ToggleRow label="Abnormal Consumption Detection" desc="Flag unusual usage patterns"              checked={form.abnormal_detection_enabled}  onChange={sett('abnormal_detection_enabled')} disabled={!canEdit} />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-2 border-t border-slate-800">
          <Field label="Forecast Horizon (days)">
            <input type="number" className={INPUT} disabled={!canEdit} value={form.forecast_horizon_days} onChange={setn('forecast_horizon_days')} min={1} max={365} />
          </Field>
          <Field label="Confidence Threshold (0–1)">
            <input type="number" className={INPUT} disabled={!canEdit} value={form.ai_confidence_threshold} onChange={setn('ai_confidence_threshold')} min={0} max={1} step={0.05} />
          </Field>
          <Field label="Leak Sensitivity (0–1)">
            <input type="number" className={INPUT} disabled={!canEdit} value={form.leak_sensitivity} onChange={setn('leak_sensitivity')} min={0} max={1} step={0.05} />
          </Field>
        </div>
        <InfoNote>AI features require the Anthropic API key configured in Notifications settings.</InfoNote>
        {canEdit && <SaveBtn onClick={handleSave} disabled={mut.isPending} pending={mut.isPending} />}
      </div>
    </div>
  );
}

// ─── Section: Water Utility ───────────────────────────────────────────────────

function WaterUtilitySection({ sm, canEdit }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    default_meter_type: '', pressure_threshold_bar: 2.5,
    min_consumption_m3: 0, max_consumption_m3: 1000,
    default_tariff_type: 'residential', reverse_flow_detection: false,
  });

  useEffect(() => {
    if (!sm || !Object.keys(sm).length) return;
    setForm(f => ({
      default_meter_type:     sv(sm.default_meter_type,     f.default_meter_type),
      pressure_threshold_bar: nv(sm.pressure_threshold_bar, f.pressure_threshold_bar),
      min_consumption_m3:     nv(sm.min_consumption_m3,     f.min_consumption_m3),
      max_consumption_m3:     nv(sm.max_consumption_m3,     f.max_consumption_m3),
      default_tariff_type:    sv(sm.default_tariff_type,    f.default_tariff_type),
      reverse_flow_detection: bv(sm.reverse_flow_detection),
    }));
  }, [sm]);

  const mut = useMutation({
    mutationFn: d => settingsAPI.updateMany(d),
    onSuccess: () => { toast.success('Water utility settings saved'); qc.invalidateQueries({ queryKey: ['settings'] }); },
    onError: e => toast.error(e?.response?.data?.error || 'Failed to save'),
  });

  const set  = k => e => setForm(f => ({ ...f, [k]: e.target.value }));
  const setn = k => e => setForm(f => ({ ...f, [k]: Number(e.target.value) }));
  const sett = k => v  => setForm(f => ({ ...f, [k]: v }));

  const handleSave = () => {
    mut.mutate([
      { key: 'default_meter_type',     value: form.default_meter_type },
      { key: 'pressure_threshold_bar', value: String(form.pressure_threshold_bar) },
      { key: 'min_consumption_m3',     value: String(form.min_consumption_m3) },
      { key: 'max_consumption_m3',     value: String(form.max_consumption_m3) },
      { key: 'default_tariff_type',    value: form.default_tariff_type },
      { key: 'reverse_flow_detection', value: String(form.reverse_flow_detection) },
    ]);
  };

  return (
    <div>
      <SectionTitle title="Water Utility Settings" desc="Meter types, pressure thresholds, and consumption bounds" />
      <div className={`${CARD} space-y-4`}>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Default Meter Type">
            <input className={INPUT} disabled={!canEdit} value={form.default_meter_type} onChange={set('default_meter_type')} placeholder="e.g. ultrasonic, mechanical" />
          </Field>
          <Field label="Default Tariff Type">
            <select className={INPUT} disabled={!canEdit} value={form.default_tariff_type} onChange={set('default_tariff_type')}>
              <option value="residential">Residential</option>
              <option value="commercial">Commercial</option>
              <option value="industrial">Industrial</option>
              <option value="government">Government</option>
            </select>
          </Field>
          <Field label="Pressure Threshold (bar)">
            <input type="number" className={INPUT} disabled={!canEdit} value={form.pressure_threshold_bar} onChange={setn('pressure_threshold_bar')} min={0} step={0.1} />
          </Field>
          <Field label="Min Consumption (m³/month)">
            <input type="number" className={INPUT} disabled={!canEdit} value={form.min_consumption_m3} onChange={setn('min_consumption_m3')} min={0} />
          </Field>
          <Field label="Max Consumption (m³/month)">
            <input type="number" className={INPUT} disabled={!canEdit} value={form.max_consumption_m3} onChange={setn('max_consumption_m3')} min={0} />
          </Field>
        </div>
        <div className="pt-2 border-t border-slate-800">
          <ToggleRow label="Reverse Flow Detection" desc="Alert when meters detect reverse water flow" checked={form.reverse_flow_detection} onChange={sett('reverse_flow_detection')} disabled={!canEdit} />
        </div>
        {canEdit && <SaveBtn onClick={handleSave} disabled={mut.isPending} pending={mut.isPending} />}
      </div>
    </div>
  );
}

// ─── Section: System Info ─────────────────────────────────────────────────────

function SystemInfoSection({ sysInfo, health, refetchSysInfo, refetchHealth }) {
  const fmtUptime = s => {
    if (!s) return '—';
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    return `${d}d ${h}h ${m}m`;
  };

  const services    = health?.services || {};
  const svcEntries  = Object.entries(services);
  const healthyCount = svcEntries.filter(([, s]) => s.status === 'healthy').length;
  const totalCount   = svcEntries.length;

  const infoCards = sysInfo ? [
    { label: 'Backend Version', value: sysInfo.backend_version || '—' },
    { label: 'Node.js Version', value: sysInfo.node_version    || '—' },
    { label: 'Database',        value: [sysInfo.db_version, sysInfo.db_size].filter(Boolean).join(' · ') || '—' },
    { label: 'Memory (RSS)',     value: sysInfo.memory_rss_mb ? `${sysInfo.memory_rss_mb} MB` : '—' },
    { label: 'Uptime',           value: fmtUptime(sysInfo.backend_uptime_s) },
    { label: 'Platform',         value: sysInfo.platform || '—' },
  ] : [];

  const healthColor = healthyCount === totalCount ? 'text-emerald-400' : healthyCount > 0 ? 'text-amber-400' : 'text-red-400';

  return (
    <div>
      <SectionTitle title="System Information" desc="Backend version, resource usage, and service health" />

      <div className="flex justify-end mb-4">
        <button onClick={() => { refetchSysInfo(); refetchHealth(); }} className={BTN_S}>
          <RefreshCw className="w-4 h-4" /> Refresh
        </button>
      </div>

      {/* Services */}
      <div className={`${CARD} mb-4`}>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-white">Service Health</h3>
          {totalCount > 0 && (
            <span className={`text-sm font-semibold ${healthColor}`}>{healthyCount}/{totalCount} healthy</span>
          )}
        </div>
        {totalCount > 0 ? (
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
            {svcEntries.map(([name, svc]) => (
              <div key={name} className="flex items-center justify-between bg-slate-800/50 rounded-lg px-3 py-2">
                <span className="text-xs text-slate-300 capitalize">{name.replace(/_/g, ' ')}</span>
                <StatusBadge ok={svc.status === 'healthy'} />
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-slate-500">No health data available</p>
        )}
      </div>

      {/* Info cards */}
      {sysInfo ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {infoCards.map(c => (
            <div key={c.label} className={CARD}>
              <p className="text-xs text-slate-400 mb-1">{c.label}</p>
              <p className="text-sm font-mono text-white break-all">{c.value}</p>
            </div>
          ))}
        </div>
      ) : (
        <div className="flex items-center justify-center py-12 text-slate-500">
          <Loader2 className="w-5 h-5 animate-spin mr-2" />
          <span className="text-sm">Loading system info…</span>
        </div>
      )}
    </div>
  );
}

// ─── Section: Role Permissions ────────────────────────────────────────────────

const ALL_ROLES = [
  'admin','manager','finance','operator','viewer',
  'customer_service','billing_officer','meter_technician','delivery_officer',
];

function RolePermissionsSection({ data }) {
  if (!data) {
    return (
      <div>
        <SectionTitle title="Role Permissions" desc="Module-level access control by role" />
        <div className="flex items-center justify-center py-12 text-slate-500">
          <Loader2 className="w-5 h-5 animate-spin mr-2" />
          <span className="text-sm">Loading permissions…</span>
        </div>
      </div>
    );
  }

  // Build module → role → {can_read, can_write, can_delete}
  const moduleMap = {};
  for (const role of Object.keys(data)) {
    for (const perm of (data[role] || [])) {
      if (!moduleMap[perm.module]) moduleMap[perm.module] = {};
      moduleMap[perm.module][role] = perm;
    }
  }
  const modules = Object.keys(moduleMap).sort();

  function Cell({ v, bg, color, letter }) {
    return v
      ? <span className={`inline-flex items-center justify-center w-5 h-5 rounded text-xs font-bold ${bg} ${color}`}>{letter}</span>
      : <span className="inline-flex items-center justify-center w-5 h-5 rounded text-xs text-slate-700">–</span>;
  }

  return (
    <div>
      <SectionTitle title="Role Permissions" desc="Module-level access control by role" />
      <div className={CARD}>
        <div className="overflow-x-auto">
          <table className="w-full text-xs min-w-max">
            <thead>
              <tr className="border-b border-slate-800">
                <th className="text-left text-slate-400 font-medium pb-3 pr-6 sticky left-0 bg-slate-900/50">Module</th>
                {ALL_ROLES.map(r => (
                  <th key={r} className="text-center text-slate-400 font-medium pb-3 px-2 whitespace-nowrap">
                    {r.replace(/_/g, ' ')}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/40">
              {modules.map(mod => (
                <tr key={mod} className="hover:bg-slate-800/20">
                  <td className="py-2.5 pr-6 text-slate-300 font-medium capitalize whitespace-nowrap sticky left-0 bg-transparent">
                    {mod.replace(/_/g, ' ')}
                  </td>
                  {ALL_ROLES.map(role => {
                    const p = moduleMap[mod]?.[role];
                    return (
                      <td key={role} className="py-2.5 px-2 text-center">
                        <div className="flex items-center justify-center gap-0.5">
                          <Cell v={p?.can_read}   bg="bg-blue-900/50"    color="text-blue-300"    letter="R" />
                          <Cell v={p?.can_write}  bg="bg-emerald-900/50" color="text-emerald-300" letter="W" />
                          <Cell v={p?.can_delete} bg="bg-red-900/50"     color="text-red-300"     letter="D" />
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Legend */}
        <div className="mt-4 flex items-center gap-4 text-xs text-slate-500">
          <span className="flex items-center gap-1">
            <span className="inline-block w-4 h-4 rounded bg-blue-900/50 text-blue-300 text-center font-bold leading-4">R</span> Read
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-4 h-4 rounded bg-emerald-900/50 text-emerald-300 text-center font-bold leading-4">W</span> Write
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-4 h-4 rounded bg-red-900/50 text-red-300 text-center font-bold leading-4">D</span> Delete
          </span>
        </div>

        <div className="mt-3">
          <InfoNote>
            Role permissions are managed via database migrations. Contact your system administrator to modify role access.
          </InfoNote>
        </div>
      </div>
    </div>
  );
}

// ─── Navigation ───────────────────────────────────────────────────────────────

const NAV = [
  { id: 'general',     label: 'General',           icon: Settings    },
  { id: 'billing',     label: 'Billing',            icon: CreditCard  },
  { id: 'notifications',label:'Notifications',      icon: Bell        },
  { id: 'security',    label: 'Security',           icon: Shield      },
  { id: 'backup',      label: 'Backup',             icon: Database    },
  { id: 'odoo',        label: 'Odoo Integration',   icon: Zap         },
  { id: 'chirpstack',  label: 'ChirpStack',         icon: Server      },
  { id: 'ai',          label: 'AI Settings',        icon: Cpu         },
  { id: 'water',       label: 'Water Utility',      icon: Droplets    },
  { id: 'sysinfo',     label: 'System Info',        icon: Activity    },
  { id: 'permissions', label: 'Role Permissions',   icon: Users       },
];

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const { user } = useAuthStore();
  const [active, setActive] = useState('general');

  const canEdit = user?.role === 'admin' || user?.role === 'manager';

  // All system_settings (flat map)
  const { data: sm = {}, isLoading: smLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: async () => {
      const res = await settingsAPI.get();
      const map = {};
      res.data.forEach(s => { map[s.key] = s.value ?? ''; });
      return map;
    },
  });

  // Billing (separate endpoint)
  const { data: billingData } = useQuery({
    queryKey: ['billingSettings'],
    queryFn: async () => { const r = await settingsAPI.getBilling(); return r.data; },
  });

  // System info (only when on that tab)
  const { data: sysInfo, refetch: refetchSysInfo } = useQuery({
    queryKey: ['sysInfo'],
    queryFn: async () => { const r = await settingsAPI.getSystemInfo(); return r.data; },
    enabled: active === 'sysinfo',
  });

  // Role permissions (only when on that tab)
  const { data: rolePerms } = useQuery({
    queryKey: ['rolePerms'],
    queryFn: async () => { const r = await settingsAPI.getRolePerms(); return r.data; },
    enabled: active === 'permissions',
  });

  // Health (always loaded — used by Odoo + ChirpStack + SysInfo tabs)
  const { data: health, refetch: refetchHealth } = useQuery({
    queryKey: ['health'],
    queryFn: async () => { const r = await systemAPI.getHealth(); return r.data; },
    staleTime: 30_000,
  });

  const renderSection = () => {
    switch (active) {
      case 'general':      return <GeneralSection       sm={sm}          canEdit={canEdit} />;
      case 'billing':      return <BillingSection       data={billingData} canEdit={canEdit} />;
      case 'notifications':return <NotificationsSection sm={sm}          canEdit={canEdit} />;
      case 'security':     return <SecuritySection      sm={sm}          canEdit={canEdit} />;
      case 'backup':       return <BackupSection        sm={sm}          canEdit={canEdit} userRole={user?.role} />;
      case 'odoo':         return <OdooSection          health={health}  />;
      case 'chirpstack':   return <ChirpStackSection    sm={sm}          health={health}  />;
      case 'ai':           return <AISettingsSection    sm={sm}          canEdit={canEdit} />;
      case 'water':        return <WaterUtilitySection  sm={sm}          canEdit={canEdit} />;
      case 'sysinfo':      return <SystemInfoSection    sysInfo={sysInfo} health={health} refetchSysInfo={refetchSysInfo} refetchHealth={refetchHealth} />;
      case 'permissions':  return <RolePermissionsSection data={rolePerms} />;
      default:             return null;
    }
  };

  return (
    <div className="flex min-h-full">
      {/* ── Sidebar ── */}
      <nav className="w-56 flex-shrink-0 bg-slate-900/50 border-r border-slate-800 min-h-screen pt-6 pb-10">
        <div className="px-4 mb-3">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Settings</p>
        </div>
        <ul className="space-y-0.5 px-2">
          {NAV.map(({ id, label, icon: Icon }) => (
            <li key={id}>
              <button
                onClick={() => setActive(id)}
                className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors text-left ${
                  active === id
                    ? 'bg-slate-800 text-white'
                    : 'text-slate-400 hover:text-white hover:bg-slate-800/50'
                }`}
              >
                <Icon className="w-4 h-4 flex-shrink-0" />
                {label}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      {/* ── Content ── */}
      <main className="flex-1 p-6 min-w-0 overflow-auto">
        {!canEdit && (
          <div className="mb-6 flex items-center gap-3 px-4 py-3 bg-amber-900/20 border border-amber-700/40 rounded-xl text-amber-300 text-sm">
            <AlertTriangle className="w-4 h-4 flex-shrink-0" />
            <span>Read-only: contact your admin to change settings</span>
          </div>
        )}

        {smLoading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-6 h-6 text-blue-400 animate-spin" />
          </div>
        ) : (
          renderSection()
        )}
      </main>
    </div>
  );
}
