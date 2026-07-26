'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery } from '@tanstack/react-query';
import { customersAPI, zonesAPI, settingsAPI, metersAPI, waterTypesAPI } from '../../../../lib/api';
import {
  Plus, Loader2, ArrowLeft, Navigation, Gauge, X, CheckCircle,
} from 'lucide-react';
import Link from 'next/link';
import toast from 'react-hot-toast';

const today = () => new Date().toISOString().split('T')[0];

const EMPTY_FORM = {
  house_number: '', full_name: '', owner_name: '',
  email: '', phone: '', mobile_money_number: '', national_id: '',
  address: '', city: '', district: '', gps_lat: '', gps_lng: '',
  tariff_type: 'residential', preferred_payment_method: 'cash',
  account_status: 'active', priority: 'normal',
  connection_date: today(), zone_id: '', water_type_id: '',
};

// ── Assign Meter overlay shown after "Save & Assign Meter" ────────────────────

function AssignMeterOverlay({ customer }) {
  const router = useRouter();
  const [meterNumber, setMeterNumber] = useState('');
  const [loading, setLoading] = useState(false);

  const handleAssign = async () => {
    const q = meterNumber.trim();
    if (!q) { toast.error('Enter a meter number'); return; }
    setLoading(true);
    try {
      const res = await metersAPI.list({ search: q, limit: 20 });
      const match = (res.data?.data || []).find(m => m.meter_number === q);
      if (!match) { toast.error('Meter not found — check the meter number'); setLoading(false); return; }
      await metersAPI.update(match.id, { customer_id: customer.id });
      toast.success(`Meter ${match.meter_number} assigned`);
      router.push(`/dashboard/customers/${customer.id}`);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to assign meter');
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="card-glow w-full max-w-md p-6 space-y-5">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-full bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center flex-shrink-0 mt-0.5">
            <CheckCircle className="w-5 h-5 text-emerald-400" />
          </div>
          <div>
            <h3 className="font-semibold text-white">Customer Created</h3>
            <p className="text-xs text-slate-400 mt-0.5">
              <span className="font-mono text-primary-400">{customer.house_number}</span> — {customer.full_name}
            </p>
          </div>
        </div>
        <div className="bg-slate-800/60 border border-slate-700/60 rounded-lg p-4">
          <p className="text-sm text-slate-300 mb-3">Assign an existing unassigned meter to this customer.</p>
          <label className="block text-xs text-slate-400 mb-1 font-medium">Meter Number</label>
          <input
            className="input"
            placeholder="e.g. NUW-0042"
            value={meterNumber}
            autoFocus
            onChange={e => setMeterNumber(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleAssign()}
          />
        </div>
        <div className="flex justify-end gap-3">
          <button
            onClick={() => router.push(`/dashboard/customers/${customer.id}`)}
            className="btn-secondary"
          >
            Skip — View Customer
          </button>
          <button onClick={handleAssign} disabled={loading} className="btn-primary">
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Gauge className="w-4 h-4" />}
            Assign Meter
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Section header ─────────────────────────────────────────────────────────────

function SectionHeader({ title, badge, badgeCls }) {
  return (
    <div className="flex items-center gap-2 mb-4">
      <h2 className="text-sm font-semibold text-white">{title}</h2>
      {badge && (
        <span className={`text-xs px-2 py-0.5 rounded-full border font-mono ${badgeCls}`}>
          {badge}
        </span>
      )}
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function AddCustomerPage() {
  const router = useRouter();
  const [form, setForm] = useState(EMPTY_FORM);
  const [saveMode, setSaveMode] = useState(null);
  const [createdCustomer, setCreatedCustomer] = useState(null);
  const [gpsLoading, setGpsLoading] = useState(false);
  const [errors, setErrors] = useState({});

  const { data: zones = [] } = useQuery({
    queryKey: ['zones'],
    queryFn: () => zonesAPI.list().then(r => r.data),
    staleTime: 2 * 60 * 1000,
  });

  const { data: settingsArr = [] } = useQuery({
    queryKey: ['settings'],
    queryFn: () => settingsAPI.get().then(r => r.data),
    staleTime: 5 * 60 * 1000,
  });

  const { data: waterTypes = [] } = useQuery({
    queryKey: ['water-types', 'active'],
    queryFn: () => waterTypesAPI.list({ active: true }).then(r => r.data),
    staleTime: 2 * 60 * 1000,
  });

  const settings = settingsArr.reduce((acc, s) => { acc[s.key] = s.value; return acc; }, {});
  const isAutoMode = (settings.house_number_mode || 'manual') === 'auto';

  const selectedZone = zones.find(z => z.id === form.zone_id);
  const autoPreview = selectedZone
    ? `${selectedZone.zone_code}-${String(Number(selectedZone.customer_seq || 0) + 1).padStart(6, '0')}`
    : null;

  const set = (key) => (e) => setForm(f => ({ ...f, [key]: e.target.value }));

  const captureGPS = () => {
    if (!navigator.geolocation) { toast.error('Geolocation not supported by this browser'); return; }
    setGpsLoading(true);
    navigator.geolocation.getCurrentPosition(
      pos => {
        setForm(f => ({
          ...f,
          gps_lat: String(pos.coords.latitude.toFixed(6)),
          gps_lng: String(pos.coords.longitude.toFixed(6)),
        }));
        setGpsLoading(false);
        toast.success('Location captured');
      },
      () => { toast.error('Could not capture location'); setGpsLoading(false); }
    );
  };

  const validate = () => {
    const e = {};
    if (!isAutoMode && !form.house_number.trim()) e.house_number = 'Required in manual mode';
    if (isAutoMode && !form.zone_id) e.zone_id = 'Zone required for auto-numbering';
    if (!form.full_name.trim()) e.full_name = 'Full name is required';
    if (!form.phone.trim()) e.phone = 'Phone is required';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const mutation = useMutation({
    mutationFn: (payload) => customersAPI.create(payload),
    onSuccess: (res) => {
      const customer = res.data;
      if (saveMode === 'assign') {
        setCreatedCustomer(customer);
      } else {
        toast.success('Customer created');
        router.push('/dashboard/customers');
      }
    },
    onError: (err) => {
      setSaveMode(null);
      toast.error(err.response?.data?.error || 'Failed to create customer');
    },
  });

  const handleSubmit = (mode) => {
    if (!validate()) return;
    setSaveMode(mode);
    mutation.mutate({
      ...form,
      house_number: isAutoMode ? '' : form.house_number.trim(),
      zone_id:      form.zone_id || null,
      gps_lat:      form.gps_lat !== '' ? form.gps_lat : null,
      gps_lng:      form.gps_lng !== '' ? form.gps_lng : null,
      connection_date: form.connection_date || null,
      national_id:  form.national_id || null,
      owner_name:   form.owner_name || null,
      mobile_money_number: form.mobile_money_number || null,
    });
  };

  const isLoading = mutation.isPending;

  return (
    <>
      <div className="p-4 lg:p-6 space-y-5 animate-fade-in">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-white font-display">Register Customer</h1>
            <p className="text-slate-400 text-sm mt-0.5">Create a new customer account for water service</p>
          </div>
          <Link href="/dashboard/customers" className="btn-secondary text-sm flex items-center gap-2">
            <ArrowLeft className="w-4 h-4" /> Back
          </Link>
        </div>

        {/* Section 1: Identification */}
        <div className="card-glow p-5">
          <SectionHeader
            title="Identification"
            badge={isAutoMode ? 'Mode B: Auto Zone-Sequence' : 'Mode A: Manual'}
            badgeCls={isAutoMode
              ? 'bg-amber-500/10 text-amber-400 border-amber-500/20'
              : 'bg-blue-500/10 text-blue-400 border-blue-500/20'}
          />
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {isAutoMode ? (
              <div>
                <label className="block text-xs text-slate-400 mb-1 font-medium">House Number</label>
                <div className="input flex items-center gap-2 cursor-default">
                  <span className="font-mono text-sm text-primary-400 flex-1">
                    {autoPreview || 'Select zone to preview…'}
                  </span>
                  <span className="text-xs text-slate-500 flex-shrink-0">auto-assigned on save</span>
                </div>
                <p className="text-xs text-slate-500 mt-1">
                  Sequence generated from zone. Change mode in System Settings.
                </p>
              </div>
            ) : (
              <div>
                <label className="block text-xs text-slate-400 mb-1 font-medium">
                  House Number <span className="text-red-400">*</span>
                </label>
                <input
                  className={`input font-mono ${errors.house_number ? 'border-red-500/50' : ''}`}
                  placeholder="e.g. 2526"
                  value={form.house_number}
                  onChange={set('house_number')}
                />
                {errors.house_number
                  ? <p className="text-xs text-red-400 mt-1">{errors.house_number}</p>
                  : <p className="text-xs text-slate-500 mt-1">Permanent identifier — cannot be changed after creation</p>}
              </div>
            )}

            <div>
              <label className="block text-xs text-slate-400 mb-1 font-medium">
                Zone{isAutoMode && <span className="text-red-400 ml-0.5">*</span>}
              </label>
              <select
                className={`select ${errors.zone_id ? 'border-red-500/50' : ''}`}
                value={form.zone_id}
                onChange={set('zone_id')}
              >
                <option value="">— Select zone —</option>
                {zones.filter(z => z.status === 'active').map(z => (
                  <option key={z.id} value={z.id}>{z.zone_code} — {z.zone_name}</option>
                ))}
              </select>
              {errors.zone_id && <p className="text-xs text-red-400 mt-1">{errors.zone_id}</p>}
            </div>
          </div>
        </div>

        {/* Section 2: Personal Information */}
        <div className="card-glow p-5">
          <SectionHeader title="Personal Information" />
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-slate-400 mb-1 font-medium">
                Full Name <span className="text-red-400">*</span>
              </label>
              <input
                className={`input ${errors.full_name ? 'border-red-500/50' : ''}`}
                placeholder="Customer's full name"
                value={form.full_name}
                onChange={set('full_name')}
              />
              {errors.full_name && <p className="text-xs text-red-400 mt-1">{errors.full_name}</p>}
            </div>

            <div>
              <label className="block text-xs text-slate-400 mb-1 font-medium">Owner Name</label>
              <input
                className="input"
                placeholder="Property owner (if different from above)"
                value={form.owner_name}
                onChange={set('owner_name')}
              />
            </div>

            <div>
              <label className="block text-xs text-slate-400 mb-1 font-medium">
                Phone <span className="text-red-400">*</span>
              </label>
              <input
                className={`input ${errors.phone ? 'border-red-500/50' : ''}`}
                placeholder="+252 61…"
                type="tel"
                value={form.phone}
                onChange={set('phone')}
              />
              {errors.phone && <p className="text-xs text-red-400 mt-1">{errors.phone}</p>}
            </div>

            <div>
              <label className="block text-xs text-slate-400 mb-1 font-medium">Mobile Money Number</label>
              <input
                className="input"
                placeholder="EVC / Zaad / Sahal / Waafi number"
                type="tel"
                value={form.mobile_money_number}
                onChange={set('mobile_money_number')}
              />
            </div>

            <div>
              <label className="block text-xs text-slate-400 mb-1 font-medium">Email</label>
              <input
                className="input"
                placeholder="customer@example.com"
                type="email"
                value={form.email}
                onChange={set('email')}
              />
            </div>

            <div>
              <label className="block text-xs text-slate-400 mb-1 font-medium">
                National ID <span className="text-slate-600 font-normal">(optional)</span>
              </label>
              <input
                className="input font-mono"
                placeholder="National ID number"
                value={form.national_id}
                onChange={set('national_id')}
              />
            </div>
          </div>
        </div>

        {/* Section 3: Location */}
        <div className="card-glow p-5">
          <SectionHeader title="Location" />
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="lg:col-span-2">
              <label className="block text-xs text-slate-400 mb-1 font-medium">Address</label>
              <textarea
                className="input min-h-[72px] resize-y"
                placeholder="Street address or location description"
                value={form.address}
                onChange={set('address')}
              />
            </div>

            <div>
              <label className="block text-xs text-slate-400 mb-1 font-medium">City</label>
              <input className="input" placeholder="e.g. Garowe" value={form.city} onChange={set('city')} />
            </div>

            <div>
              <label className="block text-xs text-slate-400 mb-1 font-medium">District</label>
              <input className="input" placeholder="e.g. Bari" value={form.district} onChange={set('district')} />
            </div>

            <div>
              <label className="block text-xs text-slate-400 mb-1 font-medium">GPS Latitude</label>
              <input
                className="input font-mono"
                placeholder="e.g. 8.40615"
                type="number"
                step="any"
                value={form.gps_lat}
                onChange={set('gps_lat')}
              />
            </div>

            <div>
              <label className="block text-xs text-slate-400 mb-1 font-medium">GPS Longitude</label>
              <div className="flex gap-2">
                <input
                  className="input font-mono flex-1"
                  placeholder="e.g. 48.48416"
                  type="number"
                  step="any"
                  value={form.gps_lng}
                  onChange={set('gps_lng')}
                />
                <button
                  type="button"
                  onClick={captureGPS}
                  disabled={gpsLoading}
                  title="Capture device location"
                  className="btn-secondary px-3 flex-shrink-0"
                >
                  {gpsLoading
                    ? <Loader2 className="w-4 h-4 animate-spin" />
                    : <Navigation className="w-4 h-4" />}
                </button>
              </div>
              <p className="text-xs text-slate-500 mt-1">Click <Navigation className="w-3 h-3 inline" /> to auto-fill from device GPS</p>
            </div>
          </div>
        </div>

        {/* Section 4: Account Settings */}
        <div className="card-glow p-5">
          <SectionHeader title="Account Settings" />
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-slate-400 mb-1 font-medium">Tariff Type</label>
              <select className="select" value={form.tariff_type} onChange={set('tariff_type')}>
                <option value="residential">Residential</option>
                <option value="commercial">Commercial</option>
                <option value="industrial">Industrial</option>
                <option value="government">Government</option>
              </select>
            </div>

            <div>
              <label className="block text-xs text-slate-400 mb-1 font-medium">Water Type</label>
              <select className="select" value={form.water_type_id} onChange={set('water_type_id')}>
                <option value="">Not set yet (assigned by first meter)</option>
                {waterTypes.map(wt => <option key={wt.id} value={wt.id}>{wt.name}</option>)}
              </select>
              <p className="text-xs text-slate-500 mt-1">A customer has exactly one water type — every meter assigned to them must match it.</p>
            </div>

            <div>
              <label className="block text-xs text-slate-400 mb-1 font-medium">Preferred Payment Method</label>
              <select className="select" value={form.preferred_payment_method} onChange={set('preferred_payment_method')}>
                <option value="cash">Cash</option>
                <option value="mobile_money">Mobile Money (EVC / Zaad / Sahal)</option>
                <option value="bank_transfer">Bank Transfer</option>
                <option value="other">Other</option>
              </select>
            </div>

            <div>
              <label className="block text-xs text-slate-400 mb-1 font-medium">Account Status</label>
              <select className="select" value={form.account_status} onChange={set('account_status')}>
                <option value="active">Active</option>
                <option value="suspended">Suspended</option>
                <option value="terminated">Terminated</option>
              </select>
            </div>

            <div>
              <label className="block text-xs text-slate-400 mb-1 font-medium">Priority</label>
              <select className="select" value={form.priority} onChange={set('priority')}>
                <option value="normal">Normal</option>
                <option value="high">High</option>
                <option value="vip">VIP</option>
              </select>
            </div>

            <div>
              <label className="block text-xs text-slate-400 mb-1 font-medium">Connection Date</label>
              <input className="input" type="date" value={form.connection_date} onChange={set('connection_date')} />
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex flex-col sm:flex-row justify-end gap-3 pb-4">
          <button
            onClick={() => router.push('/dashboard/customers')}
            className="btn-secondary"
          >
            Cancel
          </button>
          <button
            onClick={() => handleSubmit('only')}
            disabled={isLoading}
            className="btn-secondary border-primary-500/30 text-primary-400 hover:bg-primary-500/10"
          >
            {isLoading && saveMode === 'only'
              ? <Loader2 className="w-4 h-4 animate-spin" />
              : <Plus className="w-4 h-4" />}
            Save Only
          </button>
          <button
            onClick={() => handleSubmit('assign')}
            disabled={isLoading}
            className="btn-primary"
          >
            {isLoading && saveMode === 'assign'
              ? <Loader2 className="w-4 h-4 animate-spin" />
              : <Gauge className="w-4 h-4" />}
            Save &amp; Assign Meter
          </button>
        </div>
      </div>

      {/* Post-creation: Assign Meter overlay */}
      {createdCustomer && <AssignMeterOverlay customer={createdCustomer} />}
    </>
  );
}
