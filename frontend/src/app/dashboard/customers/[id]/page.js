'use client';
import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import {
  ArrowLeft, User, Phone, Mail, MapPin, Gauge, Brain,
  AlertTriangle, CheckCircle, Loader2, Edit, RefreshCw,
  TrendingUp, DollarSign, Clock, Activity, ExternalLink,
  FileText, CreditCard, X, Plus, Save, MessageSquare, Repeat2,
} from 'lucide-react';
import {
  AreaChart, Area, LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer,
} from 'recharts';
import { format, formatDistanceToNow } from 'date-fns';
import toast from 'react-hot-toast';
import api, { customersAPI, billingAPI, metersAPI, aiAPI, usersAPI } from '../../../../lib/api'; // eslint-disable-line no-unused-vars

// ── Constants ──────────────────────────────────────────────────────────────────

const STATUS_CHIP = {
  active:     'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  suspended:  'bg-amber-500/10  text-amber-400  border-amber-500/20',
  terminated: 'bg-red-500/10    text-red-400    border-red-500/20',
};

const TARIFF_CHIP = {
  residential: 'bg-blue-500/10   text-blue-400   border-blue-500/20',
  commercial:  'bg-amber-500/10  text-amber-400  border-amber-500/20',
  industrial:  'bg-purple-500/10 text-purple-400 border-purple-500/20',
  government:  'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
};

const INV_STATUS_CHIP = {
  paid:      'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  pending:   'bg-amber-500/10  text-amber-400  border-amber-500/20',
  overdue:   'bg-red-500/10    text-red-400    border-red-500/20',
  cancelled: 'bg-slate-700/50  text-slate-500  border-slate-700',
};

const TABS = [
  { id: 'info',        label: 'Info'        },
  { id: 'meters',      label: 'Meters'      },
  { id: 'billing',     label: 'Billing'     },
  { id: 'consumption', label: 'Consumption' },
  { id: 'notes',       label: 'Notes'       },
  { id: 'activity',    label: 'Activity'    },
];

// ── Formatters ────────────────────────────────────────────────────────────────

const fmt = {
  date:  (d) => !d ? '—' : format(new Date(d), 'dd MMM yyyy'),
  dt:    (d) => !d ? '—' : format(new Date(d), 'dd MMM yyyy HH:mm'),
  dist:  (d) => !d ? 'Never' : formatDistanceToNow(new Date(d), { addSuffix: true }),
  money: (v) => v == null ? '—' : `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
  num:   (v, dp = 3) => v == null ? '—' : Number(v).toFixed(dp),
  chartDate: (d) => { try { return format(new Date(d), 'MMM d'); } catch { return String(d); } },
};

// ── Shared UI ─────────────────────────────────────────────────────────────────

function Spinner() {
  return (
    <div className="flex items-center justify-center p-10">
      <div className="w-8 h-8 border-2 border-primary-500/30 border-t-primary-500 rounded-full animate-spin" />
    </div>
  );
}

function EmptyState({ icon: Icon = FileText, message = 'No data available' }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-slate-500">
      <Icon className="w-10 h-10 mb-3 opacity-25" />
      <p className="text-sm">{message}</p>
    </div>
  );
}

function Chip({ label, cls }) {
  return (
    <span className={`text-xs font-semibold px-2.5 py-0.5 rounded-full border capitalize ${cls}`}>
      {label}
    </span>
  );
}

function InfoRow({ label, value, mono = false }) {
  return (
    <div className="flex items-start justify-between gap-3 py-2 border-b border-slate-800/60 last:border-0">
      <span className="text-xs text-slate-500 flex-shrink-0 pt-0.5">{label}</span>
      <span className={`text-sm text-right break-all ${mono ? 'font-mono text-primary-400' : 'text-slate-300'}`}>
        {value ?? '—'}
      </span>
    </div>
  );
}

// ── Summary Cards ─────────────────────────────────────────────────────────────

function SummaryCards({ customerId, meters }) {
  const { data: pendingInvs } = useQuery({
    queryKey: ['customer-balance-pending', customerId],
    queryFn: () => billingAPI.list({ customer_id: customerId, status: 'pending', limit: 200 }).then(r => r.data?.data || []),
    enabled: !!customerId,
  });
  const { data: overdueInvs } = useQuery({
    queryKey: ['customer-balance-overdue', customerId],
    queryFn: () => billingAPI.list({ customer_id: customerId, status: 'overdue', limit: 200 }).then(r => r.data?.data || []),
    enabled: !!customerId,
  });

  const unpaid = [...(pendingInvs || []), ...(overdueInvs || [])];
  const outstanding = unpaid.reduce((s, inv) => s + Number(inv.total_amount || 0), 0);
  const balanceReady = !!(pendingInvs || overdueInvs);

  const lastSeen = (meters || []).reduce((latest, m) => {
    if (!m.last_seen) return latest;
    if (!latest || new Date(m.last_seen) > new Date(latest)) return m.last_seen;
    return latest;
  }, null);

  const activeMeterCount = (meters || []).filter(m => m.status === 'active' || m.is_online).length;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
      {/* Outstanding Balance */}
      <div className={`rounded-xl border p-4 ${outstanding > 0 ? 'bg-amber-500/5 border-amber-500/20' : 'bg-emerald-500/5 border-emerald-500/20'}`}>
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Outstanding Balance</p>
            <p className={`text-2xl font-bold font-display mt-1 ${outstanding > 0 ? 'text-amber-400' : 'text-emerald-400'}`}>
              {balanceReady ? fmt.money(outstanding) : '…'}
            </p>
            <p className="text-xs text-slate-500 mt-1">
              {balanceReady
                ? (unpaid.length === 0 ? 'All paid up' : `${unpaid.length} invoice${unpaid.length !== 1 ? 's' : ''} unpaid`)
                : 'Loading…'}
            </p>
          </div>
          <DollarSign className={`w-8 h-8 opacity-20 ${outstanding > 0 ? 'text-amber-400' : 'text-emerald-400'}`} />
        </div>
      </div>

      {/* Total Meters */}
      <div className="rounded-xl border border-slate-700 bg-slate-800/40 p-4">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Total Meters</p>
            <p className="text-2xl font-bold font-display mt-1 text-primary-400">{(meters || []).length}</p>
            <p className="text-xs text-slate-500 mt-1">{activeMeterCount} active</p>
          </div>
          <Gauge className="w-8 h-8 opacity-20 text-primary-400" />
        </div>
      </div>

      {/* Last Reading */}
      <div className="rounded-xl border border-slate-700 bg-slate-800/40 p-4">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Last Reading</p>
            <p className="text-2xl font-bold font-display mt-1 text-cyan-400">
              {lastSeen ? fmt.date(lastSeen) : '—'}
            </p>
            <p className="text-xs text-slate-500 mt-1">{fmt.dist(lastSeen)}</p>
          </div>
          <Clock className="w-8 h-8 opacity-20 text-cyan-400" />
        </div>
      </div>
    </div>
  );
}

// ── Edit Form ─────────────────────────────────────────────────────────────────

function EditForm({ customer, onClose }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    full_name:                customer.full_name        || '',
    owner_name:               customer.owner_name       || '',
    phone:                    customer.phone            || '',
    mobile_money_number:      customer.mobile_money_number || '',
    email:                    customer.email            || '',
    national_id:              customer.national_id      || '',
    address_ref:              customer.address_ref      || '',
    address:                  customer.address          || '',
    city:                     customer.city             || '',
    gps_lat:                  customer.gps_lat   != null ? String(customer.gps_lat)  : '',
    gps_lng:                  customer.gps_lng   != null ? String(customer.gps_lng)  : '',
    tariff_type:              customer.tariff_type      || 'residential',
    account_status:           customer.account_status   || 'active',
    preferred_payment_method: customer.preferred_payment_method || 'cash',
    priority:                 customer.priority         || 'normal',
    connection_date:          customer.connection_date  ? String(customer.connection_date).split('T')[0] : '',
    notes:                    customer.notes            || '',
  });
  const [errors, setErrors] = useState({});

  const mutation = useMutation({
    mutationFn: (payload) => customersAPI.update(customer.id, payload),
    onSuccess: () => {
      toast.success('Customer updated');
      qc.invalidateQueries({ queryKey: ['customer-detail', customer.id] });
      onClose();
    },
    onError: (err) => toast.error(err.response?.data?.error || 'Update failed'),
  });

  const validate = () => {
    const e = {};
    if (!form.full_name.trim()) e.full_name = 'Full name is required';
    if (form.gps_lat && isNaN(Number(form.gps_lat))) e.gps_lat = 'Must be a number';
    if (form.gps_lng && isNaN(Number(form.gps_lng))) e.gps_lng = 'Must be a number';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleSubmit = () => {
    if (!validate()) return;
    mutation.mutate({
      ...form,
      gps_lat: form.gps_lat !== '' ? Number(form.gps_lat) : null,
      gps_lng: form.gps_lng !== '' ? Number(form.gps_lng) : null,
      connection_date: form.connection_date || null,
    });
  };

  const F = ({ k, label, type = 'text', span = false, required = false }) => (
    <div className={span ? 'sm:col-span-2' : ''}>
      <label className="block text-xs text-slate-400 mb-1 font-medium">
        {label}{required && <span className="text-red-400 ml-0.5">*</span>}
      </label>
      <input
        type={type}
        className={`input ${errors[k] ? 'border-red-500/50' : ''}`}
        value={form[k]}
        onChange={e => setForm(p => ({ ...p, [k]: e.target.value }))}
      />
      {errors[k] && <p className="text-xs text-red-400 mt-1">{errors[k]}</p>}
    </div>
  );

  return (
    <div className="card-glow border-primary-500/20 p-5 space-y-5">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-white">Edit Customer</h3>
        <button onClick={onClose} className="btn-ghost p-1.5"><X className="w-4 h-4" /></button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <F k="full_name"           label="Full Name"          required />
        <F k="owner_name"          label="Owner Name" />
        <F k="phone"               label="Phone" />
        <F k="mobile_money_number" label="Mobile Money Number" />
        <F k="email"               label="Email"              type="email" />
        <F k="national_id"         label="National ID" />
        <F k="address_ref"         label="Address Ref" />
        <F k="city"                label="City" />

        <div className="sm:col-span-2">
          <label className="block text-xs text-slate-400 mb-1 font-medium">Address</label>
          <input className="input" value={form.address} onChange={e => setForm(p => ({ ...p, address: e.target.value }))} />
        </div>

        <div>
          <label className="block text-xs text-slate-400 mb-1 font-medium">GPS Latitude</label>
          <input
            className={`input ${errors.gps_lat ? 'border-red-500/50' : ''}`}
            placeholder="e.g. 9.0250"
            value={form.gps_lat}
            onChange={e => setForm(p => ({ ...p, gps_lat: e.target.value }))}
          />
          {errors.gps_lat && <p className="text-xs text-red-400 mt-1">{errors.gps_lat}</p>}
        </div>
        <div>
          <label className="block text-xs text-slate-400 mb-1 font-medium">GPS Longitude</label>
          <input
            className={`input ${errors.gps_lng ? 'border-red-500/50' : ''}`}
            placeholder="e.g. 38.7468"
            value={form.gps_lng}
            onChange={e => setForm(p => ({ ...p, gps_lng: e.target.value }))}
          />
          {errors.gps_lng && <p className="text-xs text-red-400 mt-1">{errors.gps_lng}</p>}
        </div>

        <div>
          <label className="block text-xs text-slate-400 mb-1 font-medium">Tariff Type</label>
          <select className="select" value={form.tariff_type} onChange={e => setForm(p => ({ ...p, tariff_type: e.target.value }))}>
            {['residential', 'commercial', 'industrial', 'government'].map(v => (
              <option key={v} value={v}>{v.charAt(0).toUpperCase() + v.slice(1)}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-slate-400 mb-1 font-medium">Account Status</label>
          <select className="select" value={form.account_status} onChange={e => setForm(p => ({ ...p, account_status: e.target.value }))}>
            {['active', 'suspended', 'terminated'].map(v => (
              <option key={v} value={v}>{v.charAt(0).toUpperCase() + v.slice(1)}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-slate-400 mb-1 font-medium">Preferred Payment Method</label>
          <select className="select" value={form.preferred_payment_method} onChange={e => setForm(p => ({ ...p, preferred_payment_method: e.target.value }))}>
            <option value="cash">Cash</option>
            <option value="mobile_money">Mobile Money (EVC / Zaad / Sahal)</option>
            <option value="bank_transfer">Bank Transfer</option>
            <option value="other">Other</option>
          </select>
        </div>
        <div>
          <label className="block text-xs text-slate-400 mb-1 font-medium">Priority</label>
          <select className="select" value={form.priority} onChange={e => setForm(p => ({ ...p, priority: e.target.value }))}>
            <option value="normal">Normal</option>
            <option value="high">High</option>
            <option value="vip">VIP</option>
          </select>
        </div>

        <div>
          <label className="block text-xs text-slate-400 mb-1 font-medium">Connection Date</label>
          <input type="date" className="input" value={form.connection_date} onChange={e => setForm(p => ({ ...p, connection_date: e.target.value }))} />
        </div>

        <div className="sm:col-span-2">
          <label className="block text-xs text-slate-400 mb-1 font-medium">Notes</label>
          <textarea
            className="input min-h-[72px] resize-y"
            value={form.notes}
            onChange={e => setForm(p => ({ ...p, notes: e.target.value }))}
          />
        </div>
      </div>

      <div className="flex items-center justify-end gap-3 pt-1">
        <button onClick={onClose} className="btn-secondary">Cancel</button>
        <button onClick={handleSubmit} disabled={mutation.isPending} className="btn-primary">
          {mutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          Save Changes
        </button>
      </div>
    </div>
  );
}

// ── Tab 1: Info ───────────────────────────────────────────────────────────────

function InfoTab({ customer }) {
  const gpsDisplay = customer.gps_lat != null && customer.gps_lng != null
    ? `${Number(customer.gps_lat).toFixed(6)}, ${Number(customer.gps_lng).toFixed(6)}`
    : null;

  const leftRows = [
    { label: 'House Number',    value: customer.house_number, mono: true },
    { label: 'Full Name',       value: customer.full_name },
    { label: 'Owner Name',      value: customer.owner_name },
    { label: 'Phone',           value: customer.phone },
    { label: 'Mobile Money',    value: customer.mobile_money_number },
    { label: 'Email',           value: customer.email },
    { label: 'National ID',     value: customer.national_id, mono: true },
    { label: 'Address Ref',     value: customer.address_ref },
  ];
  const rightRows = [
    { label: 'City',             value: customer.city },
    { label: 'Full Address',     value: customer.address },
    { label: 'GPS Location',     value: gpsDisplay },
    { label: 'Tariff Type',      value: customer.tariff_type },
    { label: 'Payment Method',   value: customer.preferred_payment_method },
    { label: 'Connection Date',  value: fmt.date(customer.connection_date) },
    { label: 'Account Status',   value: customer.account_status },
    { label: 'Priority',         value: customer.priority },
  ];
  const sysRows = [
    { label: 'Odoo Customer ID', value: customer.odoo_id || customer.odoo_partner_id, mono: true },
    { label: 'Created By',       value: customer.created_by_name || (customer.created_by ? String(customer.created_by).slice(0, 8) + '…' : null) },
    { label: 'Created Date',     value: fmt.dt(customer.created_at) },
    { label: 'Last Updated',     value: fmt.dt(customer.updated_at) },
  ];

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div className="card-glow p-5">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Contact &amp; Identity</p>
          {leftRows.map(r => <InfoRow key={r.label} label={r.label} value={r.value} mono={r.mono} />)}
        </div>
        <div className="card-glow p-5">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Location &amp; Account</p>
          {rightRows.map(r => <InfoRow key={r.label} label={r.label} value={r.value} mono={r.mono} />)}
        </div>
      </div>
      <div className="card-glow p-5">
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">System Info</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-10">
          {sysRows.map(r => <InfoRow key={r.label} label={r.label} value={r.value} mono={r.mono} />)}
        </div>
      </div>
    </div>
  );
}

// ── Tab 2: Meters ─────────────────────────────────────────────────────────────

function AssignMeterModal({ customerId, onClose, onAssigned }) {
  const [meterNumber, setMeterNumber] = useState('');
  const [loading, setLoading] = useState(false);

  const handleAssign = async () => {
    const q = meterNumber.trim();
    if (!q) { toast.error('Enter a meter number'); return; }
    setLoading(true);
    try {
      const res = await metersAPI.list({ search: q, limit: 20 });
      const list = res.data?.data || [];
      const match = list.find(m => m.meter_number === q);
      if (!match) { toast.error('Meter not found — check the meter number'); setLoading(false); return; }
      await metersAPI.update(match.id, { customer_id: customerId });
      toast.success(`Meter ${match.meter_number} assigned`);
      onAssigned();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to assign meter');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="card-glow w-full max-w-sm p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-white">Assign Meter</h3>
          <button onClick={onClose} className="btn-ghost p-1.5"><X className="w-4 h-4" /></button>
        </div>
        <div>
          <label className="block text-xs text-slate-400 mb-1 font-medium">Meter Number</label>
          <input
            className="input"
            placeholder="e.g. WM-0042"
            value={meterNumber}
            autoFocus
            onChange={e => setMeterNumber(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleAssign()}
          />
        </div>
        <div className="flex justify-end gap-3">
          <button onClick={onClose} className="btn-secondary">Cancel</button>
          <button onClick={handleAssign} disabled={loading} className="btn-primary">
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            Assign
          </button>
        </div>
      </div>
    </div>
  );
}

function ReplaceMeterModal({ meter, onClose, onReplaced }) {
  const [form, setForm] = useState({ new_meter_number: '', new_device_eui: '', new_serial_number: '', replacement_reason: '' });
  const [loading, setLoading] = useState(false);

  const handleReplace = async () => {
    if (!form.new_meter_number.trim() || !form.new_device_eui.trim()) {
      toast.error('New meter number and device EUI are required');
      return;
    }
    setLoading(true);
    try {
      await metersAPI.replaceMeter(meter.id, form);
      toast.success(`Meter ${meter.meter_number} replaced successfully`);
      onReplaced();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to replace meter');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="card-glow w-full max-w-md p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-white">Replace Meter</h3>
            <p className="text-xs text-slate-500 mt-0.5">Replacing: <span className="font-mono text-primary-400">{meter.meter_number}</span></p>
          </div>
          <button onClick={onClose} className="btn-ghost p-1.5"><X className="w-4 h-4" /></button>
        </div>

        <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-3 text-xs text-amber-300">
          The old meter will be marked <strong>Replaced</strong>. The new meter becomes <strong>Active</strong>. Full history is preserved.
        </div>

        <div className="space-y-3">
          <div>
            <label className="block text-xs text-slate-400 mb-1 font-medium">New Meter Number <span className="text-red-400">*</span></label>
            <input className="input" placeholder="e.g. WM-0099" value={form.new_meter_number}
              onChange={e => setForm(p => ({ ...p, new_meter_number: e.target.value }))} autoFocus />
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1 font-medium">New Device EUI <span className="text-red-400">*</span></label>
            <input className="input font-mono" placeholder="16 hex characters" value={form.new_device_eui}
              onChange={e => setForm(p => ({ ...p, new_device_eui: e.target.value }))} />
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1 font-medium">Serial Number</label>
            <input className="input" placeholder="Optional" value={form.new_serial_number}
              onChange={e => setForm(p => ({ ...p, new_serial_number: e.target.value }))} />
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1 font-medium">Replacement Reason</label>
            <select className="select" value={form.replacement_reason} onChange={e => setForm(p => ({ ...p, replacement_reason: e.target.value }))}>
              <option value="">— Select reason —</option>
              <option value="faulty">Faulty meter</option>
              <option value="tampered">Tampered / vandalized</option>
              <option value="upgrade">Meter upgrade</option>
              <option value="relocation">Customer relocation</option>
              <option value="scheduled">Scheduled replacement</option>
              <option value="other">Other</option>
            </select>
          </div>
        </div>

        <div className="flex justify-end gap-3">
          <button onClick={onClose} className="btn-secondary">Cancel</button>
          <button onClick={handleReplace} disabled={loading} className="btn-primary">
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Repeat2 className="w-4 h-4" />}
            Replace Meter
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Meter detail expansion panel ──────────────────────────────────────────────
function MeterDetailPanel({ meterId }) {
  const { data: health, isLoading: hLoading } = useQuery({
    queryKey: ['meter-health', meterId],
    queryFn: () => metersAPI.getHealth(meterId).then(r => r.data),
    staleTime: 60_000,
  });
  const { data: consumptionRaw, isLoading: cLoading } = useQuery({
    queryKey: ['meter-consumption-7d', meterId],
    queryFn: () => metersAPI.getConsumption(meterId, { period: 'daily', from: new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10) }).then(r => r.data?.data || []),
    staleTime: 300_000,
  });
  const { data: leaksRaw } = useQuery({
    queryKey: ['meter-leaks', meterId],
    queryFn: () => metersAPI.getLeaks(meterId, { limit: 3 }).then(r => r.data?.data || []),
    staleTime: 120_000,
  });
  const { data: alarmsRaw } = useQuery({
    queryKey: ['meter-alarms', meterId],
    queryFn: () => metersAPI.list({ customer_id: null }).then(() => []),  // placeholder; alarms come via meter detail
    enabled: false,
  });

  const isLoading = hLoading || cLoading;
  if (isLoading) return (
    <div className="py-6 flex items-center justify-center gap-2 text-slate-500 text-sm">
      <Loader2 className="w-4 h-4 animate-spin" /> Loading device details…
    </div>
  );

  const h = health || {};
  const scoreColor = h.overall_score >= 85 ? 'text-emerald-400' : h.overall_score >= 60 ? 'text-yellow-400' : 'text-red-400';
  const statusColor = { healthy: 'text-emerald-400', warning: 'text-yellow-400', critical: 'text-red-400', offline: 'text-slate-400' }[h.status] || 'text-slate-400';

  const consumption7d = Array.isArray(consumptionRaw) ? consumptionRaw : [];
  const leaks = Array.isArray(leaksRaw) ? leaksRaw : [];

  return (
    <div className="bg-slate-900/60 border-t border-slate-700/50 p-4 grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
      {/* Health Overview */}
      <div className="space-y-2">
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Device Health</p>
        <div className="flex items-center gap-2">
          <span className={`text-2xl font-bold ${scoreColor}`}>{h.overall_score ?? '—'}</span>
          <span className="text-slate-500">/ 100</span>
          <span className={`text-xs font-semibold capitalize ${statusColor}`}>{h.status || '—'}</span>
        </div>
        <div className="space-y-1 text-xs text-slate-400">
          <div className="flex justify-between"><span>Battery</span><span className="text-white">{h.battery?.health_pct != null ? `${h.battery.health_pct}%` : '—'} ({h.battery?.voltage != null ? `${Number(h.battery.voltage).toFixed(2)} V` : '—'})</span></div>
          <div className="flex justify-between"><span>Signal (RSSI)</span><span className="text-white">{h.signal?.avg_rssi_dbm != null ? `${h.signal.avg_rssi_dbm} dBm` : '—'}</span></div>
          <div className="flex justify-between"><span>SNR</span><span className="text-white">{h.signal?.avg_snr_db != null ? `${h.signal.avg_snr_db} dB` : '—'}</span></div>
          <div className="flex justify-between"><span>Pressure</span><span className="text-white">{h.device?.pressure != null ? `${h.device.pressure} bar` : '—'}</span></div>
          <div className="flex justify-between"><span>Packet Success</span><span className="text-white">{h.connectivity?.packet_success_pct != null ? `${h.connectivity.packet_success_pct}%` : '—'}</span></div>
          <div className="flex justify-between"><span>7d Uptime</span><span className="text-white">{h.connectivity?.uptime_7d_pct != null ? `${h.connectivity.uptime_7d_pct}%` : '—'}</span></div>
          <div className="flex justify-between"><span>Gateway</span><span className="font-mono text-slate-300 text-xs">{h.gateway?.last_gateway_eui?.slice(-8) || '—'}</span></div>
          <div className="flex justify-between"><span>Firmware</span><span className="text-white">{h.device?.firmware_version || '—'}</span></div>
        </div>
      </div>

      {/* 7-day Consumption */}
      <div className="space-y-2">
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">7-Day Consumption</p>
        {consumption7d.length === 0 ? (
          <p className="text-xs text-slate-500 mt-4">No daily data available</p>
        ) : (
          <div className="space-y-1">
            {consumption7d.slice(-7).map((row, i) => {
              const val = Number(row.consumption_m3 || row.consumption || 0);
              const max = Math.max(...consumption7d.map(r => Number(r.consumption_m3 || r.consumption || 0)), 0.001);
              return (
                <div key={i} className="flex items-center gap-2">
                  <span className="text-xs text-slate-500 w-16 shrink-0">{String(row.date || row.period || '').slice(5, 10)}</span>
                  <div className="flex-1 bg-slate-800 rounded-full h-1.5">
                    <div className="bg-primary-500 h-1.5 rounded-full" style={{ width: `${(val / max) * 100}%` }} />
                  </div>
                  <span className="text-xs text-white w-14 text-right">{val.toFixed(3)} m³</span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Recent Leaks */}
      <div className="space-y-2">
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Recent Leaks</p>
        {leaks.length === 0 ? (
          <p className="text-xs text-slate-500 mt-4">No leak events recorded</p>
        ) : leaks.map(lk => {
          const sevColor = { low: 'text-blue-400', medium: 'text-yellow-400', high: 'text-orange-400', critical: 'text-red-400' }[lk.severity] || 'text-slate-400';
          return (
            <div key={lk.id} className="bg-slate-800/60 rounded-lg p-2.5 space-y-1">
              <div className="flex items-center justify-between">
                <span className={`text-xs font-semibold ${sevColor} capitalize`}>{lk.severity}</span>
                <span className={`text-xs px-1.5 py-0.5 rounded capitalize ${lk.status === 'active' ? 'bg-red-500/10 text-red-400' : 'bg-slate-700 text-slate-400'}`}>{lk.status}</span>
              </div>
              <p className="text-xs text-slate-300 capitalize">{(lk.detection_type || '').replace(/_/g, ' ')}</p>
              <p className="text-xs text-slate-500">{lk.detected_at ? new Date(lk.detected_at).toLocaleString() : ''}</p>
            </div>
          );
        })}
        <Link href={`/dashboard/meters/${meterId}`} className="text-xs text-primary-400 hover:text-primary-300 flex items-center gap-1 mt-2">
          <ExternalLink className="w-3 h-3" /> Full meter view
        </Link>
      </div>
    </div>
  );
}

function MetersTab({ customerId, initialMeters }) {
  const qc = useQueryClient();
  const [showModal, setShowModal] = useState(false);
  const [replacingMeter, setReplacingMeter] = useState(null);
  const [expandedMeterId, setExpandedMeterId] = useState(null);

  const { data: meters = [], isLoading } = useQuery({
    queryKey: ['customer-meters-list', customerId],
    queryFn: () => metersAPI.list({ customer_id: customerId, limit: 100 }).then(r => r.data?.data || []),
    initialData: initialMeters?.length ? initialMeters : undefined,
    enabled: !!customerId,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['customer-detail', customerId] });
    qc.invalidateQueries({ queryKey: ['customer-meters-list', customerId] });
  };

  const handleAssigned = () => { setShowModal(false); invalidate(); };
  const handleReplaced = () => { setReplacingMeter(null); invalidate(); };

  const METER_STATUS_CLS = {
    active:   'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
    inactive: 'bg-slate-700/50 text-slate-400 border-slate-700',
    faulty:   'bg-red-500/10 text-red-400 border-red-500/20',
    removed:  'bg-slate-700/50 text-slate-500 border-slate-700',
    replaced: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  };

  return (
    <>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-sm text-slate-400">{meters.length} meter{meters.length !== 1 ? 's' : ''} assigned</p>
          <button onClick={() => setShowModal(true)} className="btn-primary text-sm">
            <Plus className="w-4 h-4" /> Assign Meter
          </button>
        </div>
        <div className="card-glow overflow-hidden">
          {isLoading ? <Spinner /> : meters.length === 0 ? (
            <EmptyState icon={Gauge} message="No meters assigned to this customer" />
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table text-sm">
                <thead>
                  <tr>
                    <th></th>
                    <th>Meter No.</th><th>Device EUI</th><th>Status</th>
                    <th>Battery</th><th>RSSI</th><th>Valve</th>
                    <th>Last Seen</th><th>Last Reading</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {meters.map(m => {
                    const online = m.is_online;
                    const battV = Number(m.battery_voltage);
                    const lowBatt = !isNaN(battV) && battV < 3.2;
                    const valveOpen = m.valve_status === 'open';
                    const isActive = m.status === 'active';
                    const isExpanded = expandedMeterId === m.id;
                    return (
                      <>
                        <tr key={m.id} className={m.status === 'replaced' ? 'opacity-60' : ''}>
                          <td>
                            <button
                              onClick={() => setExpandedMeterId(isExpanded ? null : m.id)}
                              className={`w-5 h-5 rounded flex items-center justify-center text-slate-500 hover:text-white transition-all ${isExpanded ? 'rotate-90 text-primary-400' : ''}`}
                              title={isExpanded ? 'Collapse' : 'Expand details'}
                            >
                              <Activity className="w-3.5 h-3.5" />
                            </button>
                          </td>
                          <td><span className="font-mono text-xs text-primary-400 font-medium">{m.meter_number}</span></td>
                          <td><span className="font-mono text-xs text-slate-500">{m.device_eui || '—'}</span></td>
                          <td>
                            <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border font-medium capitalize ${
                              METER_STATUS_CLS[m.status] || 'text-slate-400'
                            }`}>
                              {isActive && <span className={`w-1.5 h-1.5 rounded-full ${online ? 'bg-emerald-400' : 'bg-red-400'}`} />}
                              {isActive ? (online ? 'Online' : 'Offline') : (m.status || '—')}
                            </span>
                          </td>
                          <td>
                            <span className={`text-xs font-medium ${lowBatt ? 'text-red-400' : 'text-emerald-400'}`}>
                              {m.battery_voltage != null ? `${Number(m.battery_voltage).toFixed(2)} V` : '—'}
                            </span>
                          </td>
                          <td><span className="text-xs text-slate-400">{m.rssi != null ? `${m.rssi} dBm` : '—'}</span></td>
                          <td>
                            <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border capitalize ${
                              valveOpen ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-red-500/10 text-red-400 border-red-500/20'
                            }`}>
                              {m.valve_status || '—'}
                            </span>
                          </td>
                          <td className="text-xs text-slate-400">{fmt.dist(m.last_seen)}</td>
                          <td className="text-xs text-slate-400">
                            {m.total_consumption != null ? `${Number(m.total_consumption).toFixed(3)} m³` : '—'}
                          </td>
                          <td>
                            <div className="flex items-center gap-1">
                              {isActive && (
                                <button
                                  onClick={() => setReplacingMeter(m)}
                                  className="btn-ghost py-1 px-2 text-xs text-amber-400 hover:text-amber-300"
                                  title="Replace this meter"
                                >
                                  <Repeat2 className="w-3.5 h-3.5" />
                                </button>
                              )}
                              <Link href={`/dashboard/meters/${m.id}`} className="btn-ghost py-1 px-2 text-xs">
                                <ExternalLink className="w-3.5 h-3.5" />
                              </Link>
                            </div>
                          </td>
                        </tr>
                        {isExpanded && (
                          <tr key={`${m.id}-detail`}>
                            <td colSpan={10} className="p-0">
                              <MeterDetailPanel meterId={m.id} />
                            </td>
                          </tr>
                        )}
                      </>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
      {showModal && <AssignMeterModal customerId={customerId} onClose={() => setShowModal(false)} onAssigned={handleAssigned} />}
      {replacingMeter && <ReplaceMeterModal meter={replacingMeter} onClose={() => setReplacingMeter(null)} onReplaced={handleReplaced} />}
    </>
  );
}

// ── Tab 3: Billing ────────────────────────────────────────────────────────────

function RegisterPaymentForm({ invoice, onClose }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ amount: '', method: 'cash', reference: '', note: '' });

  const mutation = useMutation({
    mutationFn: (d) => billingAPI.recordPayment(invoice.id, d),
    onSuccess: () => {
      toast.success('Payment recorded');
      qc.invalidateQueries({ queryKey: ['customer-billing'] });
      qc.invalidateQueries({ queryKey: ['customer-payments'] });
      onClose();
    },
    onError: (err) => toast.error(err.response?.data?.error || 'Failed to record payment'),
  });

  const handleSubmit = () => {
    if (!form.amount || Number(form.amount) <= 0) { toast.error('Enter a valid amount'); return; }
    mutation.mutate({ ...form, amount: Number(form.amount) });
  };

  return (
    <div className="card-glow border-primary-500/20 p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h4 className="font-semibold text-white">Register Payment</h4>
          <p className="text-xs text-slate-500 mt-0.5">Invoice: {invoice.invoice_number}</p>
        </div>
        <button onClick={onClose} className="btn-ghost p-1.5"><X className="w-4 h-4" /></button>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-xs text-slate-400 mb-1 font-medium">Amount <span className="text-red-400">*</span></label>
          <input type="number" className="input" placeholder="0.00" min="0.01" step="0.01"
            value={form.amount} onChange={e => setForm(p => ({ ...p, amount: e.target.value }))} />
        </div>
        <div>
          <label className="block text-xs text-slate-400 mb-1 font-medium">Method</label>
          <select className="select" value={form.method} onChange={e => setForm(p => ({ ...p, method: e.target.value }))}>
            {['cash', 'bank_transfer', 'mobile_money', 'cheque', 'other'].map(v => (
              <option key={v} value={v}>{v.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-slate-400 mb-1 font-medium">Reference</label>
          <input className="input" placeholder="Transaction ref" value={form.reference} onChange={e => setForm(p => ({ ...p, reference: e.target.value }))} />
        </div>
        <div>
          <label className="block text-xs text-slate-400 mb-1 font-medium">Note</label>
          <input className="input" placeholder="Optional note" value={form.note} onChange={e => setForm(p => ({ ...p, note: e.target.value }))} />
        </div>
      </div>
      <div className="flex justify-end gap-3">
        <button onClick={onClose} className="btn-secondary">Cancel</button>
        <button onClick={handleSubmit} disabled={mutation.isPending} className="btn-primary">
          {mutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <CreditCard className="w-4 h-4" />}
          Record Payment
        </button>
      </div>
    </div>
  );
}

function BillingTab({ customerId }) {
  const [subTab, setSubTab] = useState('invoices');
  const [showPayForm, setShowPayForm] = useState(false);

  const { data: billingData, isLoading: invLoading } = useQuery({
    queryKey: ['customer-billing', customerId],
    queryFn: () => billingAPI.list({ customer_id: customerId, limit: 200 }).then(r => r.data),
    enabled: !!customerId,
  });
  const invoices = billingData?.data || [];

  const outstanding = invoices
    .filter(inv => ['pending', 'overdue'].includes(inv.status))
    .reduce((s, inv) => s + Number(inv.total_amount || 0), 0);
  const unpaidInvoice = invoices.find(inv => ['pending', 'overdue'].includes(inv.status));

  const invoiceIdKey = invoices.slice(0, 5).map(i => i.id).join(',');

  const { data: allPayments = [], isLoading: payLoading } = useQuery({
    queryKey: ['customer-payments', customerId, invoiceIdKey],
    queryFn: async () => {
      const first5 = invoices.slice(0, 5);
      const results = await Promise.all(
        first5.map(inv =>
          billingAPI.getPayments(inv.id)
            .then(r => (Array.isArray(r.data) ? r.data : []).map(p => ({ ...p, invoice_number: inv.invoice_number })))
            .catch(() => [])
        )
      );
      return results.flat().sort((a, b) =>
        new Date(b.payment_date || b.created_at) - new Date(a.payment_date || a.created_at)
      );
    },
    enabled: invoices.length > 0,
  });

  return (
    <div className="space-y-5">
      {/* Outstanding balance banner */}
      <div className={`rounded-xl border p-4 flex flex-wrap items-center justify-between gap-3 ${
        outstanding > 0 ? 'bg-amber-500/5 border-amber-500/20' : 'bg-emerald-500/5 border-emerald-500/20'
      }`}>
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-slate-400">Outstanding Balance</p>
          <p className={`text-3xl font-bold font-display mt-1 ${outstanding > 0 ? 'text-amber-400' : 'text-emerald-400'}`}>
            {fmt.money(outstanding)}
          </p>
          {outstanding === 0 && (
            <p className="text-xs text-emerald-400 flex items-center gap-1 mt-1"><CheckCircle className="w-3.5 h-3.5" /> All invoices paid</p>
          )}
        </div>
        {outstanding > 0 && unpaidInvoice && !showPayForm && (
          <button onClick={() => setShowPayForm(true)} className="btn-primary text-sm">
            <CreditCard className="w-4 h-4" /> Register Payment
          </button>
        )}
      </div>

      {showPayForm && unpaidInvoice && (
        <RegisterPaymentForm invoice={unpaidInvoice} onClose={() => setShowPayForm(false)} />
      )}

      {/* Sub-tabs */}
      <div className="flex gap-1 border-b border-slate-800">
        {[
          { id: 'invoices', label: `Invoices (${invoices.length})` },
          { id: 'payments', label: `Payments (${allPayments.length})` },
        ].map(t => (
          <button key={t.id} onClick={() => setSubTab(t.id)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              subTab === t.id ? 'border-primary-500 text-primary-400' : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}>{t.label}
          </button>
        ))}
      </div>

      {subTab === 'invoices' && (
        <div className="card-glow overflow-hidden">
          {invLoading ? <Spinner /> : invoices.length === 0 ? (
            <EmptyState icon={FileText} message="No invoices found" />
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table text-sm">
                <thead>
                  <tr>
                    <th>Invoice No.</th><th>Issue Date</th><th>Due Date</th>
                    <th>Amount</th><th>Paid</th><th>Balance</th>
                    <th>Status</th><th>PDF</th><th>Odoo ID</th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.map(inv => {
                    const paid = Number(inv.total_paid || 0);
                    const balance = Number(inv.total_amount || 0) - paid;
                    return (
                      <tr key={inv.id}>
                        <td><span className="font-mono text-xs text-primary-400">{inv.invoice_number}</span></td>
                        <td className="text-slate-400 text-xs">{fmt.date(inv.issue_date)}</td>
                        <td className={`text-xs ${inv.status === 'overdue' ? 'text-red-400 font-medium' : 'text-slate-400'}`}>
                          {fmt.date(inv.due_date)}
                        </td>
                        <td className="font-medium text-white">{fmt.money(inv.total_amount)}</td>
                        <td className="text-emerald-400">{fmt.money(paid)}</td>
                        <td className={`font-medium ${balance > 0 ? 'text-amber-400' : 'text-slate-500'}`}>{fmt.money(balance)}</td>
                        <td>
                          <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border capitalize ${
                            INV_STATUS_CHIP[inv.status] || 'bg-slate-800 text-slate-400 border-slate-700'
                          }`}>{inv.status}</span>
                        </td>
                        <td>
                          <Link href={`/dashboard/billing/${inv.id}`} className="btn-ghost py-1 px-2 text-xs" title="View invoice">
                            <FileText className="w-3.5 h-3.5" />
                          </Link>
                        </td>
                        <td><span className="font-mono text-xs text-slate-500">{inv.odoo_id || '—'}</span></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {subTab === 'payments' && (
        <div className="card-glow overflow-hidden">
          {payLoading ? <Spinner /> : allPayments.length === 0 ? (
            <EmptyState icon={CreditCard} message="No payment records found" />
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table text-sm">
                <thead>
                  <tr>
                    <th>Date</th><th>Amount</th><th>Method</th>
                    <th>Reference</th><th>Invoice</th><th>Odoo ID</th>
                  </tr>
                </thead>
                <tbody>
                  {allPayments.map((p, i) => (
                    <tr key={p.id || i}>
                      <td className="text-slate-400 text-xs">{fmt.date(p.payment_date || p.created_at)}</td>
                      <td className="font-medium text-emerald-400">{fmt.money(p.amount)}</td>
                      <td className="text-slate-400 capitalize text-xs">{(p.method || '—').replace(/_/g, ' ')}</td>
                      <td className="font-mono text-xs text-slate-500">{p.reference || '—'}</td>
                      <td className="font-mono text-xs text-primary-400">{p.invoice_number || '—'}</td>
                      <td className="font-mono text-xs text-slate-500">{p.odoo_id || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Tab 4: Consumption ────────────────────────────────────────────────────────

function LeakDetectionCard({ meter }) {
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);

  const run = async () => {
    setLoading(true);
    try {
      const res = await aiAPI.leakDetection(meter.id);
      setResult(res.data);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Leak detection failed');
    } finally {
      setLoading(false);
    }
  };

  const riskCls = {
    low:    'bg-emerald-500/10 border-emerald-500/20 text-emerald-400',
    medium: 'bg-amber-500/10  border-amber-500/20  text-amber-400',
    high:   'bg-red-500/10    border-red-500/20    text-red-400',
  };

  return (
    <div className="card-glow p-5 space-y-4">
      <div className="flex items-center gap-2">
        <Brain className="w-4 h-4 text-purple-400" />
        <h4 className="font-semibold text-white text-sm">Leak Detection</h4>
        <span className="text-xs text-slate-600 ml-auto">{meter.meter_number}</span>
      </div>
      {!result ? (
        <button onClick={run} disabled={loading}
          className="w-full py-2.5 rounded-lg border bg-purple-600/10 hover:bg-purple-600/20 border-purple-500/30 text-purple-400 text-sm font-medium transition-colors flex items-center justify-center gap-2 disabled:opacity-60">
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Brain className="w-4 h-4" />}
          {loading ? 'Analyzing…' : 'Run Leak Detection'}
        </button>
      ) : (
        <div className="space-y-3">
          <div className={`flex items-center gap-2 px-3 py-2 rounded-lg border ${riskCls[result.riskLevel] || riskCls.low}`}>
            <AlertTriangle className="w-4 h-4 flex-shrink-0" />
            <span className="font-semibold capitalize">{result.riskLevel || 'Unknown'} Risk</span>
          </div>
          {result.analysis && <p className="text-xs text-slate-400 leading-relaxed">{result.analysis}</p>}
          {Array.isArray(result.indicators) && result.indicators.length > 0 && (
            <ul className="space-y-1">
              {result.indicators.map((ind, i) => (
                <li key={i} className="flex items-start gap-2 text-xs text-slate-300">
                  <span className="text-slate-600 mt-0.5 flex-shrink-0">•</span>
                  {typeof ind === 'string' ? ind : JSON.stringify(ind)}
                </li>
              ))}
            </ul>
          )}
          <button onClick={() => setResult(null)} className="text-xs text-slate-500 hover:text-slate-300 transition-colors">
            Clear &amp; run again
          </button>
        </div>
      )}
    </div>
  );
}

function ForecastCard({ meter }) {
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);

  const run = async () => {
    setLoading(true);
    try {
      const res = await aiAPI.forecast(meter.id, 30);
      setResult(res.data);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Forecast generation failed');
    } finally {
      setLoading(false);
    }
  };

  const forecastData = Array.isArray(result?.forecast) ? result.forecast
    : Array.isArray(result) ? result : [];

  const hasValidData = forecastData.length > 0 && forecastData.some(d => {
    const v = d.predicted;
    return v != null && String(v) !== 'NaN' && !isNaN(Number(v));
  });

  return (
    <div className="card-glow p-5 space-y-4">
      <div className="flex items-center gap-2">
        <TrendingUp className="w-4 h-4 text-cyan-400" />
        <h4 className="font-semibold text-white text-sm">30-Day Consumption Forecast</h4>
      </div>
      {!result ? (
        <button onClick={run} disabled={loading}
          className="w-full py-2.5 rounded-lg border bg-cyan-600/10 hover:bg-cyan-600/20 border-cyan-500/30 text-cyan-400 text-sm font-medium transition-colors flex items-center justify-center gap-2 disabled:opacity-60">
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <TrendingUp className="w-4 h-4" />}
          {loading ? 'Generating…' : 'Generate Forecast'}
        </button>
      ) : !hasValidData ? (
        <div className="rounded-lg border border-slate-700 bg-slate-800/40 p-5 text-center">
          <TrendingUp className="w-8 h-8 text-slate-600 mx-auto mb-2" />
          <p className="text-sm text-slate-300 font-medium">Insufficient data</p>
          <p className="text-xs text-slate-500 mt-1">Need at least 10 readings for forecast</p>
          <button onClick={() => setResult(null)} className="text-xs text-slate-500 hover:text-slate-300 mt-3 transition-colors block mx-auto">
            Clear
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={forecastData} margin={{ top: 5, right: 5, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
              <XAxis dataKey="day" tick={{ fill: '#64748b', fontSize: 10 }} tickFormatter={(v, i) => i % 5 === 0 ? `D${v}` : ''} />
              <YAxis tick={{ fill: '#64748b', fontSize: 10 }} unit=" m³" width={50} />
              <Tooltip
                contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8 }}
                labelStyle={{ color: '#94a3b8' }}
                labelFormatter={v => `Day ${v}`}
                formatter={(v, name) => [`${Number(v).toFixed(3)} m³`, name]}
              />
              <Line type="monotone" dataKey="upper_bound" stroke="#334155" strokeWidth={1} strokeDasharray="4 2" dot={false} name="Upper" />
              <Line type="monotone" dataKey="lower_bound" stroke="#334155" strokeWidth={1} strokeDasharray="4 2" dot={false} name="Lower" />
              <Line type="monotone" dataKey="predicted"   stroke="#06b6d4" strokeWidth={2} dot={false} name="Predicted" />
            </LineChart>
          </ResponsiveContainer>
          {result.summary && <p className="text-xs text-slate-400 leading-relaxed">{result.summary}</p>}
          <button onClick={() => setResult(null)} className="text-xs text-slate-500 hover:text-slate-300 transition-colors">
            Clear &amp; regenerate
          </button>
        </div>
      )}
    </div>
  );
}

function ConsumptionTab({ customer }) {
  const meters = customer?.meters || [];
  const activeMeter = meters.find(m => m.status === 'active') || meters[0];

  const { data: rawReadings, isLoading } = useQuery({
    queryKey: ['customer-readings', activeMeter?.id],
    queryFn: () => metersAPI.getReadings(activeMeter.id, { limit: 90 }).then(r => {
      const d = r.data;
      return Array.isArray(d) ? d : (d?.data || []);
    }),
    enabled: !!activeMeter?.id,
  });

  const readings = rawReadings || [];
  const tableRows = [...readings].reverse().slice(0, 10);

  if (!activeMeter) {
    return (
      <div className="card-glow p-5">
        <EmptyState icon={Gauge} message="No meters assigned — cannot show consumption data" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Meter label */}
      <div className="flex items-center gap-2 text-sm text-slate-400">
        <Gauge className="w-4 h-4 text-slate-500" />
        Showing data for:
        <span className="font-mono text-primary-400">{activeMeter.meter_number}</span>
        {meters.length > 1 && <span className="text-xs text-slate-600">({meters.length} meters total)</span>}
      </div>

      {/* Chart */}
      <div className="card-glow p-5">
        <h3 className="font-semibold text-white mb-4">Consumption — Last 90 Days</h3>
        {isLoading ? <Spinner /> : readings.length === 0 ? (
          <EmptyState icon={Activity} message="No reading data available for this meter" />
        ) : (
          <ResponsiveContainer width="100%" height={230}>
            <AreaChart data={readings} margin={{ top: 5, right: 5, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="cGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor="#42A5F5" stopOpacity={0.35} />
                  <stop offset="95%" stopColor="#42A5F5" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
              <XAxis dataKey="period" tick={{ fill: '#64748b', fontSize: 10 }} tickFormatter={fmt.chartDate} />
              <YAxis tick={{ fill: '#64748b', fontSize: 10 }} unit=" m³" width={55} />
              <Tooltip
                contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8 }}
                labelStyle={{ color: '#94a3b8' }}
                labelFormatter={fmt.chartDate}
                formatter={(v) => [`${Number(v).toFixed(3)} m³`, 'Consumption']}
              />
              <Area type="monotone" dataKey="consumption" name="Consumption" stroke="#42A5F5" fill="url(#cGrad)" strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Table */}
      <div className="card-glow overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-800/60">
          <h3 className="font-semibold text-white text-sm">Recent Readings (last 10)</h3>
        </div>
        {isLoading ? <Spinner /> : tableRows.length === 0 ? (
          <EmptyState message="No readings recorded" />
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table text-sm">
              <thead>
                <tr>
                  <th>Date</th><th>Total (m³)</th><th>Flow (L/min)</th>
                  <th>Battery (V)</th><th>Pressure (kPa)</th><th>RSSI (dBm)</th>
                </tr>
              </thead>
              <tbody>
                {tableRows.map((r, i) => (
                  <tr key={i}>
                    <td className="text-slate-400 text-xs">{r.period ? fmt.chartDate(r.period) : '—'}</td>
                    <td className="font-medium text-white">{fmt.num(r.consumption)}</td>
                    <td className="text-cyan-400">{r.avg_flow != null ? Number(r.avg_flow).toFixed(2) : '—'}</td>
                    <td className={Number(r.battery_voltage) < 3.2 ? 'text-red-400' : 'text-emerald-400'}>
                      {r.battery_voltage != null ? Number(r.battery_voltage).toFixed(2) : '—'}
                    </td>
                    <td className="text-amber-400">{r.pressure != null ? Number(r.pressure).toFixed(1) : '—'}</td>
                    <td className="text-slate-400">{r.rssi ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* AI Section */}
      <div>
        <h3 className="font-semibold text-white mb-3">AI Analysis</h3>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <LeakDetectionCard meter={activeMeter} />
          <ForecastCard meter={activeMeter} />
        </div>
      </div>
    </div>
  );
}

// ── Tab 5: Notes ──────────────────────────────────────────────────────────────

function NotesTab({ customerId }) {
  const qc = useQueryClient();
  const [noteText, setNoteText] = useState('');

  const { data: notes, isLoading } = useQuery({
    queryKey: ['customer-notes', customerId],
    queryFn: () => api.get(`/customers/${customerId}/notes`).then(r => {
      const d = r.data;
      return Array.isArray(d) ? d : (d?.data || []);
    }),
    enabled: !!customerId,
  });

  const mutation = useMutation({
    mutationFn: (note) => api.post(`/customers/${customerId}/notes`, { note }),
    onSuccess: () => {
      toast.success('Note added');
      qc.invalidateQueries({ queryKey: ['customer-notes', customerId] });
      setNoteText('');
    },
    onError: (err) => toast.error(err.response?.data?.error || 'Failed to add note'),
  });

  const getInitials = (name) => {
    if (!name) return '?';
    return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
  };

  const handleSave = () => {
    if (!noteText.trim()) { toast.error('Note cannot be empty'); return; }
    mutation.mutate(noteText.trim());
  };

  return (
    <div className="space-y-4">
      {isLoading ? <Spinner /> : !notes || notes.length === 0 ? (
        <div className="card-glow p-5">
          <EmptyState icon={MessageSquare} message="No notes yet — add the first one below" />
        </div>
      ) : (
        <div className="space-y-3">
          {notes.map((n) => (
            <div key={n.id} className="card-glow p-4 flex gap-3">
              <div className="w-8 h-8 rounded-full bg-primary-500/15 border border-primary-500/25 flex-shrink-0 flex items-center justify-center">
                <span className="text-xs font-bold text-primary-400 leading-none">
                  {getInitials(n.user_name || n.full_name || n.username)}
                </span>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline justify-between gap-2 mb-1">
                  <span className="text-sm font-medium text-white">
                    {n.user_name || n.full_name || n.username || 'Staff'}
                  </span>
                  <span className="text-xs text-slate-500 flex-shrink-0">{fmt.dist(n.created_at)}</span>
                </div>
                <p className="text-sm text-slate-300 leading-relaxed">{n.note}</p>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="card-glow p-4 space-y-3">
        <h4 className="text-sm font-medium text-white">Add Note</h4>
        <textarea
          className="input min-h-[96px] resize-y"
          placeholder="Enter a note about this customer…"
          value={noteText}
          onChange={e => setNoteText(e.target.value)}
        />
        <div className="flex justify-end">
          <button onClick={handleSave} disabled={mutation.isPending} className="btn-primary">
            {mutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <MessageSquare className="w-4 h-4" />}
            Save Note
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Tab 6: Activity ───────────────────────────────────────────────────────────

const ACTIVITY_CFG = {
  customer_created:  { icon: User,       color: 'bg-blue-500/20    text-blue-400'    },
  customer_updated:  { icon: User,       color: 'bg-blue-500/20    text-blue-400'    },
  invoice_created:   { icon: FileText,   color: 'bg-purple-500/20  text-purple-400'  },
  invoice_updated:   { icon: FileText,   color: 'bg-purple-500/20  text-purple-400'  },
  create_invoice:    { icon: FileText,   color: 'bg-purple-500/20  text-purple-400'  },
  update_invoice:    { icon: FileText,   color: 'bg-purple-500/20  text-purple-400'  },
  payment:           { icon: CreditCard, color: 'bg-emerald-500/20 text-emerald-400' },
  record_payment:    { icon: CreditCard, color: 'bg-emerald-500/20 text-emerald-400' },
  meter_assigned:    { icon: Gauge,      color: 'bg-amber-500/20   text-amber-400'   },
  meter_removed:     { icon: Gauge,      color: 'bg-amber-500/20   text-amber-400'   },
  valve_open:        { icon: Activity,   color: 'bg-cyan-500/20    text-cyan-400'    },
  valve_close:       { icon: Activity,   color: 'bg-cyan-500/20    text-cyan-400'    },
};
const DEFAULT_CFG = { icon: Activity, color: 'bg-slate-700 text-slate-400' };

function ActivityTab({ customerId }) {
  const { data: events, isLoading } = useQuery({
    queryKey: ['customer-activity', customerId],
    queryFn: () =>
      api.get(`/customers/${customerId}/activity`)
        .then(r => { const d = r.data; return Array.isArray(d) ? d : (d?.data || []); })
        .catch(() => []),
    enabled: !!customerId,
  });

  if (isLoading) return <Spinner />;
  if (!events || events.length === 0) {
    return (
      <div className="card-glow p-5">
        <EmptyState icon={Activity} message="No activity recorded yet" />
      </div>
    );
  }

  return (
    <div className="relative pl-5">
      <div className="absolute left-5 top-0 bottom-0 w-px bg-slate-800" />
      <div className="space-y-0">
        {events.map((event, i) => {
          const key = event.action || event.type || '';
          const cfg = ACTIVITY_CFG[key] || DEFAULT_CFG;
          const Icon = cfg.icon;
          const label = event.description || key.replace(/_/g, ' ');
          return (
            <div key={event.id || i} className="flex gap-4">
              <div className={`relative z-10 flex-shrink-0 -ml-5 w-10 h-10 rounded-full flex items-center justify-center ${cfg.color}`}>
                <Icon className="w-4 h-4" />
              </div>
              <div className="flex-1 min-w-0 py-3 border-b border-slate-800/50 last:border-0">
                <p className="text-sm text-slate-200 capitalize">{label}</p>
                <p className="text-xs text-slate-500 mt-0.5">{fmt.dist(event.created_at)}</p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function CustomerProfilePage() {
  const { id } = useParams();
  const router = useRouter();
  const [activeTab, setActiveTab] = useState('info');
  const [showEdit, setShowEdit] = useState(false);
  const [syncLoading, setSyncLoading] = useState(false);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['customer-detail', id],
    queryFn: () => customersAPI.get(id).then(r => r.data),
    enabled: !!id,
  });

  const customer = data?.customer || data;
  const meters   = data?.meters   || [];

  const handleSync = async () => {
    setSyncLoading(true);
    try {
      await api.post(`/odoo/sync/customer/${id}`);
      toast.success('Customer synced to Odoo');
      refetch();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Odoo sync failed');
    } finally {
      setSyncLoading(false);
    }
  };

  // ── Loading ──
  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-10 h-10 border-2 border-primary-500/30 border-t-primary-500 rounded-full animate-spin" />
      </div>
    );
  }

  // ── Error / Not found ──
  if (error || !customer) {
    return (
      <div className="p-6">
        <div className="card-glow p-10 text-center">
          <AlertTriangle className="w-10 h-10 text-red-400 mx-auto mb-3" />
          <p className="text-slate-200 font-semibold">Customer not found</p>
          <p className="text-slate-500 text-sm mt-1">
            {error?.response?.data?.error || 'The requested customer does not exist.'}
          </p>
          <button onClick={() => router.back()} className="btn-secondary text-sm mt-5">
            <ArrowLeft className="w-4 h-4" /> Go Back
          </button>
        </div>
      </div>
    );
  }

  const odooId = customer.odoo_id || customer.odoo_partner_id;

  return (
    <div className="p-4 lg:p-6 space-y-5 animate-fade-in">

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-start gap-4">
        <button
          onClick={() => router.back()}
          aria-label="Go back"
          className="p-2 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors flex-shrink-0 mt-0.5"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>

        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-2xl font-bold text-white font-display">{customer.full_name}</h1>
            <span className="font-mono text-xs text-primary-400 bg-primary-500/10 border border-primary-500/20 px-2.5 py-1 rounded-lg">
              {customer.house_number}
            </span>
            {customer.account_status && (
              <Chip
                label={customer.account_status}
                cls={STATUS_CHIP[customer.account_status] || 'bg-slate-800 text-slate-400 border-slate-700'}
              />
            )}
            {customer.tariff_type && (
              <Chip
                label={customer.tariff_type}
                cls={TARIFF_CHIP[customer.tariff_type] || 'bg-slate-800 text-slate-400 border-slate-700'}
              />
            )}
            {odooId && (
              <span className="text-xs text-slate-500 bg-slate-800/50 border border-slate-700 px-2 py-0.5 rounded font-mono">
                Odoo #{odooId}
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-4 mt-2">
            {customer.phone && (
              <span className="flex items-center gap-1.5 text-xs text-slate-400">
                <Phone className="w-3 h-3" />{customer.phone}
              </span>
            )}
            {customer.email && (
              <span className="flex items-center gap-1.5 text-xs text-slate-400">
                <Mail className="w-3 h-3" />{customer.email}
              </span>
            )}
            {customer.city && (
              <span className="flex items-center gap-1.5 text-xs text-slate-400">
                <MapPin className="w-3 h-3" />{customer.city}
              </span>
            )}
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            onClick={handleSync}
            disabled={syncLoading}
            className="btn-secondary text-xs"
          >
            {syncLoading
              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
              : <RefreshCw className="w-3.5 h-3.5" />
            }
            Sync to Odoo
          </button>
          <button
            onClick={() => setShowEdit(prev => !prev)}
            className={`btn-secondary text-xs ${showEdit ? 'border-primary-500/40 text-primary-400 bg-primary-500/5' : ''}`}
          >
            <Edit className="w-3.5 h-3.5" />
            {showEdit ? 'Cancel' : 'Edit'}
          </button>
        </div>
      </div>

      {/* ── Edit Form (collapsible) ─────────────────────────────────────── */}
      {showEdit && (
        <EditForm customer={customer} onClose={() => setShowEdit(false)} />
      )}

      {/* ── Summary Cards ───────────────────────────────────────────────── */}
      <SummaryCards customerId={id} meters={meters} />

      {/* ── Tab Bar ─────────────────────────────────────────────────────── */}
      <div className="flex gap-0 border-b border-slate-800 overflow-x-auto">
        {TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-4 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 transition-colors ${
              activeTab === tab.id
                ? 'border-primary-500 text-primary-400'
                : 'border-transparent text-slate-400 hover:text-slate-200 hover:border-slate-700'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* ── Tab Content ─────────────────────────────────────────────────── */}
      <div>
        {activeTab === 'info'        && <InfoTab customer={customer} />}
        {activeTab === 'meters'      && <MetersTab customerId={id} initialMeters={meters} />}
        {activeTab === 'billing'     && <BillingTab customerId={id} />}
        {activeTab === 'consumption' && <ConsumptionTab customer={{ ...customer, meters }} />}
        {activeTab === 'notes'       && <NotesTab customerId={id} />}
        {activeTab === 'activity'    && <ActivityTab customerId={id} />}
      </div>

    </div>
  );
}
