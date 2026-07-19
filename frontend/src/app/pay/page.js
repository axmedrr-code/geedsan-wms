'use client';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  Search, User, AlertCircle, CreditCard, Banknote, Building2,
  ChevronRight, Loader2, Receipt, CheckCircle2, RefreshCw
} from 'lucide-react';
import { portalAPI } from '../../lib/api';

const PROVIDER_META = {
  simulation:    { label: 'Test / Simulation',             icon: Receipt,    color: 'text-amber-400',  desc: 'Complete payment instantly (test mode)', needsPhone: false },
  stripe:        { label: 'Card / Apple Pay / Google Pay', icon: CreditCard, color: 'text-blue-400',   desc: 'Secure card payment via Stripe',         needsPhone: false },
  bank_transfer: { label: 'Bank Transfer',                 icon: Building2,  color: 'text-green-400',  desc: 'Manual bank transfer — staff confirmation required', needsPhone: false },
  sahal:         { label: 'Sahal (Mobile Money)',          icon: Banknote,   color: 'text-emerald-400', desc: 'Pay with Sahal USSD — receive a prompt on your phone', needsPhone: true },
  evc:           { label: 'EVC Plus (Mobile Money)',       icon: Banknote,   color: 'text-cyan-400',   desc: 'Pay with EVC Plus USSD — receive a prompt on your phone', needsPhone: true },
};

export default function PayPortalPage() {
  const router = useRouter();

  // ── Stage machine ─────────────────────────────────────────────────────────
  const [stage, setStage] = useState('lookup'); // lookup | found | checkout | redirecting
  const [houseInput, setHouseInput] = useState('');
  const [customer, setCustomer] = useState(null);
  const [invoices, setInvoices] = useState([]);
  const [selectedInvoice, setSelectedInvoice] = useState(null); // null = pay all
  const [availableProviders, setAvailableProviders] = useState([]);
  const [selectedProvider, setSelectedProvider] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Load available providers once on mount
  useEffect(() => {
    portalAPI.providers()
      .then(r => {
        setAvailableProviders(r.data);
        if (r.data.length > 0) setSelectedProvider(r.data[0].value);
      })
      .catch(() => setAvailableProviders([{ value: 'simulation', label: 'Test / Simulation' }]));
  }, []);

  // ── Lookup handler ────────────────────────────────────────────────────────
  const handleLookup = async (e) => {
    e.preventDefault();
    setError('');
    if (!houseInput.trim()) return;
    setLoading(true);
    try {
      const [custRes, invRes] = await Promise.all([
        portalAPI.lookup(houseInput.trim()),
        // invoices loaded in parallel — fallback if lookup 404s
        Promise.resolve(null),
      ]);
      const cust = custRes.data;
      setCustomer(cust);

      const invRes2 = await portalAPI.invoices(cust.id);
      setInvoices(invRes2.data);
      setSelectedInvoice(null);
      setStage('found');
    } catch (err) {
      const msg = err.response?.data?.error || 'Customer not found. Check the house number and try again.';
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  // ── Checkout handler ──────────────────────────────────────────────────────
  const handleCheckout = async () => {
    setError('');
    if (!selectedProvider) { setError('Please select a payment method.'); return; }
    const meta = PROVIDER_META[selectedProvider];
    if (meta?.needsPhone && !phoneNumber.trim()) {
      setError(`Please enter your ${meta.label} phone number.`);
      return;
    }
    setLoading(true);
    setStage('redirecting');
    try {
      const res = await portalAPI.checkout({
        customer_id:  customer.id,
        invoice_id:   selectedInvoice?.id || null,
        provider:     selectedProvider,
        phone_number: meta?.needsPhone ? phoneNumber.trim() : undefined,
      });
      const { session_id, checkout_url } = res.data;
      router.push(checkout_url.startsWith('http') ? checkout_url : `/pay/session/${session_id}`);
    } catch (err) {
      const msg = err.response?.data?.error || 'Failed to start checkout. Please try again.';
      setError(msg);
      setStage('found');
      setLoading(false);
    }
  };

  const totalOutstanding = invoices.reduce((s, i) => s + i.outstanding, 0);
  const payAmount = selectedInvoice ? selectedInvoice.outstanding : totalOutstanding;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="flex-1 flex items-start justify-center px-4 py-8">
      <div className="w-full max-w-lg space-y-4">

        {/* Title */}
        <div className="text-center mb-6">
          <h1 className="text-xl font-bold text-white">Pay Your Water Bill</h1>
          <p className="text-slate-400 text-sm mt-1">Enter your house number to view and pay outstanding invoices</p>
        </div>

        {/* Error banner */}
        {error && (
          <div className="flex items-start gap-3 bg-red-500/10 border border-red-500/30 text-red-400 rounded-lg p-3 text-sm">
            <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* ── STAGE: Lookup ─────────────────────────────────────────────── */}
        {stage === 'lookup' && (
          <form onSubmit={handleLookup} className="card p-6 space-y-4">
            <label className="block">
              <span className="text-sm font-medium text-slate-300 mb-1.5 block">House Number / Account Number</span>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                <input
                  type="text"
                  value={houseInput}
                  onChange={e => setHouseInput(e.target.value)}
                  placeholder="e.g. HN-001 or A-205"
                  className="input pl-9 w-full"
                  autoFocus
                />
              </div>
            </label>
            <button
              type="submit"
              disabled={loading || !houseInput.trim()}
              className="btn-primary w-full flex items-center justify-center gap-2"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
              {loading ? 'Searching…' : 'Find Account'}
            </button>
          </form>
        )}

        {/* ── STAGE: Found ──────────────────────────────────────────────── */}
        {(stage === 'found' || stage === 'redirecting') && customer && (
          <>
            {/* Customer card */}
            <div className="card p-4 flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-primary-500/20 border border-primary-500/30 flex items-center justify-center flex-shrink-0">
                <User className="w-5 h-5 text-primary-400" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-white font-semibold truncate">{customer.full_name}</p>
                <p className="text-slate-400 text-xs">{customer.house_number}{customer.zone ? ` · ${customer.zone}` : ''}</p>
              </div>
              <button
                onClick={() => { setStage('lookup'); setCustomer(null); setInvoices([]); setError(''); }}
                className="text-slate-500 hover:text-slate-300 text-xs flex items-center gap-1 flex-shrink-0"
              >
                <RefreshCw className="w-3 h-3" /> Change
              </button>
            </div>

            {/* Invoices */}
            {invoices.length === 0 ? (
              <div className="card p-6 text-center">
                <CheckCircle2 className="w-10 h-10 text-primary-400 mx-auto mb-3" />
                <p className="text-white font-semibold">Account is up to date</p>
                <p className="text-slate-400 text-sm mt-1">No outstanding invoices found.</p>
              </div>
            ) : (
              <div className="card divide-y divide-slate-800">
                <div className="px-4 py-3 flex items-center justify-between">
                  <p className="text-sm font-semibold text-slate-300">Outstanding Invoices</p>
                  <p className="text-xs text-slate-500">{invoices.length} invoice{invoices.length !== 1 ? 's' : ''}</p>
                </div>

                {/* "Pay all" option */}
                <button
                  type="button"
                  onClick={() => setSelectedInvoice(null)}
                  className={`w-full px-4 py-3 flex items-center gap-3 text-left transition-colors ${
                    selectedInvoice === null
                      ? 'bg-primary-500/10 border-l-2 border-primary-500'
                      : 'hover:bg-slate-800/50'
                  }`}
                >
                  <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${
                    selectedInvoice === null ? 'border-primary-400 bg-primary-400' : 'border-slate-600'
                  }`}>
                    {selectedInvoice === null && <div className="w-1.5 h-1.5 rounded-full bg-white" />}
                  </div>
                  <div className="flex-1">
                    <p className="text-white text-sm font-medium">Pay all outstanding</p>
                    <p className="text-slate-400 text-xs">{invoices.length} invoice{invoices.length !== 1 ? 's' : ''}</p>
                  </div>
                  <p className="text-white font-bold font-mono text-sm">${totalOutstanding.toFixed(2)}</p>
                </button>

                {invoices.map(inv => (
                  <button
                    key={inv.id}
                    type="button"
                    onClick={() => setSelectedInvoice(inv)}
                    className={`w-full px-4 py-3 flex items-center gap-3 text-left transition-colors ${
                      selectedInvoice?.id === inv.id
                        ? 'bg-primary-500/10 border-l-2 border-primary-500'
                        : 'hover:bg-slate-800/50'
                    }`}
                  >
                    <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${
                      selectedInvoice?.id === inv.id ? 'border-primary-400 bg-primary-400' : 'border-slate-600'
                    }`}>
                      {selectedInvoice?.id === inv.id && <div className="w-1.5 h-1.5 rounded-full bg-white" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-white text-sm font-medium font-mono">{inv.invoice_number}</p>
                      <p className="text-slate-400 text-xs">
                        Due {inv.due_date ? new Date(inv.due_date).toLocaleDateString() : '—'}
                        {inv.status === 'overdue' && (
                          <span className="ml-2 text-red-400 font-semibold">OVERDUE</span>
                        )}
                      </p>
                    </div>
                    <p className={`font-bold font-mono text-sm ${inv.status === 'overdue' ? 'text-red-400' : 'text-white'}`}>
                      ${inv.outstanding.toFixed(2)}
                    </p>
                  </button>
                ))}
              </div>
            )}

            {/* Provider selection + checkout */}
            {invoices.length > 0 && (
              <div className="card p-4 space-y-4">
                <p className="text-sm font-semibold text-slate-300">Payment Method</p>

                <div className="space-y-2">
                  {availableProviders.map(({ value }) => {
                    const meta = PROVIDER_META[value] || { label: value, icon: CreditCard, color: 'text-slate-400', desc: '' };
                    const Icon = meta.icon;
                    return (
                      <button
                        key={value}
                        type="button"
                        onClick={() => setSelectedProvider(value)}
                        className={`w-full flex items-center gap-3 p-3 rounded-lg border transition-all ${
                          selectedProvider === value
                            ? 'border-primary-500/60 bg-primary-500/10'
                            : 'border-slate-700/60 bg-slate-800/40 hover:border-slate-600'
                        }`}
                      >
                        <Icon className={`w-5 h-5 flex-shrink-0 ${meta.color}`} />
                        <div className="flex-1 text-left">
                          <p className="text-white text-sm font-medium">{meta.label}</p>
                          {meta.desc && <p className="text-slate-500 text-xs">{meta.desc}</p>}
                        </div>
                        <div className={`w-4 h-4 rounded-full border-2 flex-shrink-0 flex items-center justify-center ${
                          selectedProvider === value ? 'border-primary-400 bg-primary-400' : 'border-slate-600'
                        }`}>
                          {selectedProvider === value && <div className="w-1.5 h-1.5 rounded-full bg-white" />}
                        </div>
                      </button>
                    );
                  })}
                </div>

                {/* Phone number for mobile money providers */}
                {PROVIDER_META[selectedProvider]?.needsPhone && (
                  <div className="pt-1">
                    <label className="block text-sm font-medium text-slate-300 mb-1.5">
                      {PROVIDER_META[selectedProvider].label} Phone Number
                    </label>
                    <input
                      type="tel"
                      value={phoneNumber}
                      onChange={e => setPhoneNumber(e.target.value)}
                      placeholder="+252 61 XXX XXXX"
                      className="input w-full font-mono"
                      autoComplete="tel"
                    />
                    <p className="text-slate-500 text-xs mt-1">You will receive a USSD payment prompt on this number.</p>
                  </div>
                )}

                {/* Summary + submit */}
                <div className="border-t border-slate-800 pt-4">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-slate-400 text-sm">Amount due</span>
                    <span className="text-white font-bold text-lg font-mono">${payAmount.toFixed(2)}</span>
                  </div>
                  <button
                    type="button"
                    onClick={handleCheckout}
                    disabled={loading || stage === 'redirecting' || !selectedProvider}
                    className="btn-primary w-full flex items-center justify-center gap-2"
                  >
                    {stage === 'redirecting' ? (
                      <><Loader2 className="w-4 h-4 animate-spin" /> Processing…</>
                    ) : (
                      <>Pay ${payAmount.toFixed(2)} <ChevronRight className="w-4 h-4" /></>
                    )}
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
