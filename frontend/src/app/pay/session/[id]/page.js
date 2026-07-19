'use client';
import { useState, useEffect, useCallback } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import {
  Loader2, CheckCircle2, XCircle, Clock, CreditCard,
  Building2, Receipt, AlertCircle, RefreshCw, ExternalLink, Smartphone
} from 'lucide-react';
import { portalAPI } from '../../../../lib/api';

const STATUS_CONFIG = {
  pending:    { color: 'text-amber-400', bg: 'bg-amber-400/10', border: 'border-amber-400/30', label: 'Awaiting Payment' },
  processing: { color: 'text-blue-400',  bg: 'bg-blue-400/10',  border: 'border-blue-400/30',  label: 'Processing…' },
  completed:  { color: 'text-green-400', bg: 'bg-green-400/10', border: 'border-green-400/30', label: 'Payment Successful' },
  failed:     { color: 'text-red-400',   bg: 'bg-red-400/10',   border: 'border-red-400/30',   label: 'Payment Failed' },
  expired:    { color: 'text-slate-400', bg: 'bg-slate-400/10', border: 'border-slate-400/30', label: 'Session Expired' },
  cancelled:  { color: 'text-slate-400', bg: 'bg-slate-400/10', border: 'border-slate-400/30', label: 'Cancelled' },
};

export default function SessionPage() {
  const { id } = useParams();
  const searchParams = useSearchParams();

  const [session, setSession] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState('');
  const [pollCount, setPollCount] = useState(0);

  const fetchSession = useCallback(async () => {
    try {
      const res = await portalAPI.getSession(id);
      setSession(res.data);
      setLoadError('');
    } catch (err) {
      setLoadError(err.response?.data?.error || 'Session not found');
    }
  }, [id]);

  // Initial load
  useEffect(() => { fetchSession(); }, [fetchSession]);

  // Auto-poll when status is 'processing' (e.g. waiting for Stripe webhook)
  useEffect(() => {
    if (!session) return;
    if (!['processing'].includes(session.status)) return;
    const t = setTimeout(() => {
      setPollCount(n => n + 1);
      fetchSession();
    }, 2500);
    return () => clearTimeout(t);
  }, [session, pollCount, fetchSession]);

  // Handle Stripe redirect-back with stripe_status param
  const stripeStatus = searchParams.get('stripe_status');
  useEffect(() => {
    if (stripeStatus === 'success' && session?.status === 'pending') {
      // Stripe redirected back — start polling for webhook to arrive
      const t = setTimeout(fetchSession, 1500);
      return () => clearTimeout(t);
    }
  }, [stripeStatus, session?.status, fetchSession]);

  const handleConfirm = async () => {
    setConfirmError('');
    setConfirming(true);
    try {
      await portalAPI.confirmSession(id);
      await fetchSession();
    } catch (err) {
      setConfirmError(err.response?.data?.error || 'Confirmation failed. Please try again.');
    } finally {
      setConfirming(false);
    }
  };

  // ── Loading ────────────────────────────────────────────────────────────────
  if (!session && !loadError) {
    return (
      <div className="flex-1 flex items-center justify-center py-16">
        <Loader2 className="w-8 h-8 animate-spin text-primary-400" />
      </div>
    );
  }

  // ── Session not found ──────────────────────────────────────────────────────
  if (loadError) {
    return (
      <div className="flex-1 flex items-center justify-center px-4 py-8">
        <div className="max-w-md w-full card p-8 text-center">
          <XCircle className="w-12 h-12 text-red-400 mx-auto mb-4" />
          <h2 className="text-white font-semibold text-lg mb-2">Session Not Found</h2>
          <p className="text-slate-400 text-sm mb-6">{loadError}</p>
          <a href="/pay" className="btn-primary inline-flex items-center gap-2">
            Start a new payment
          </a>
        </div>
      </div>
    );
  }

  const cfg = STATUS_CONFIG[session.status] || STATUS_CONFIG.pending;
  const isCompleted = session.status === 'completed';
  const isFailed = ['failed', 'expired', 'cancelled'].includes(session.status);
  const isProcessing = session.status === 'processing';
  const isPending = session.status === 'pending';

  return (
    <div className="flex-1 flex items-start justify-center px-4 py-8">
      <div className="w-full max-w-lg space-y-4">

        {/* Status banner */}
        <div className={`rounded-xl border p-4 flex items-center gap-3 ${cfg.bg} ${cfg.border}`}>
          {isCompleted  && <CheckCircle2 className={`w-6 h-6 flex-shrink-0 ${cfg.color}`} />}
          {isFailed     && <XCircle      className={`w-6 h-6 flex-shrink-0 ${cfg.color}`} />}
          {isProcessing && <Loader2      className={`w-6 h-6 flex-shrink-0 animate-spin ${cfg.color}`} />}
          {isPending    && <Clock        className={`w-6 h-6 flex-shrink-0 ${cfg.color}`} />}
          <div>
            <p className={`font-semibold ${cfg.color}`}>{cfg.label}</p>
            {isProcessing && (
              <p className="text-slate-400 text-xs mt-0.5">Verifying payment — this takes a few seconds…</p>
            )}
            {isCompleted && session.payment_reference && (
              <p className="text-slate-300 text-xs mt-0.5 font-mono">Receipt: {session.payment_reference}</p>
            )}
          </div>
        </div>

        {/* Payment details card */}
        <div className="card divide-y divide-slate-800">
          <div className="px-4 py-3 flex items-center justify-between">
            <p className="text-sm font-semibold text-slate-300">Payment Details</p>
            <button onClick={fetchSession} className="text-slate-500 hover:text-slate-300">
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          </div>

          {[
            { label: 'Account',        value: `${session.full_name} — ${session.house_number}` },
            { label: 'Invoice',        value: session.invoice_number || 'All outstanding invoices' },
            { label: 'Amount',         value: `$${Number(session.amount).toFixed(2)} ${session.currency}`, mono: true, bold: true },
            { label: 'Payment Method', value: ({ simulation: 'Simulation (Test)', bank_transfer: 'Bank Transfer', stripe: 'Stripe', sahal: 'Sahal (Mobile Money)', evc: 'EVC Plus (Mobile Money)' })[session.provider] || session.provider },
            session.payment_reference && { label: 'Receipt Number', value: session.payment_reference, mono: true },
          ].filter(Boolean).map(row => (
            <div key={row.label} className="px-4 py-2.5 flex items-center justify-between">
              <span className="text-slate-400 text-sm">{row.label}</span>
              <span className={`text-right text-sm ${row.bold ? 'text-white font-bold' : 'text-slate-200'} ${row.mono ? 'font-mono' : ''}`}>
                {row.value}
              </span>
            </div>
          ))}

          {session.expires_at && isPending && (
            <div className="px-4 py-2.5 flex items-center justify-between">
              <span className="text-slate-400 text-sm">Session expires</span>
              <span className="text-amber-400 text-sm font-mono">
                {new Date(session.expires_at).toLocaleTimeString()}
              </span>
            </div>
          )}
        </div>

        {/* ── Simulation confirm button ──────────────────────────────────── */}
        {isPending && session.provider === 'simulation' && (
          <div className="card p-4 space-y-3">
            <p className="text-sm text-slate-300">
              This is a <strong className="text-amber-400">test simulation</strong> payment.
              Click below to complete the payment instantly.
            </p>
            {confirmError && (
              <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/30 text-red-400 rounded-lg p-3 text-sm">
                <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                <span>{confirmError}</span>
              </div>
            )}
            <button
              type="button"
              onClick={handleConfirm}
              disabled={confirming}
              className="btn-primary w-full flex items-center justify-center gap-2"
            >
              {confirming ? (
                <><Loader2 className="w-4 h-4 animate-spin" /> Processing Payment…</>
              ) : (
                <><CheckCircle2 className="w-4 h-4" /> Confirm Payment — ${Number(session.amount).toFixed(2)}</>
              )}
            </button>
          </div>
        )}

        {/* ── Bank transfer instructions ─────────────────────────────────── */}
        {isPending && session.provider === 'bank_transfer' && (
          <div className="card p-4 space-y-3">
            <div className="flex items-center gap-2 mb-1">
              <Building2 className="w-4 h-4 text-green-400" />
              <p className="text-sm font-semibold text-white">Bank Transfer Instructions</p>
            </div>
            <div className="bg-slate-900/60 rounded-lg p-3 text-sm space-y-1.5 border border-slate-700/60">
              <div className="flex justify-between"><span className="text-slate-400">Bank Name</span><span className="text-white font-mono">Salaam Somali Bank</span></div>
              <div className="flex justify-between"><span className="text-slate-400">Account Name</span><span className="text-white">NUWACO Water Utility</span></div>
              <div className="flex justify-between"><span className="text-slate-400">Reference</span><span className="text-white font-mono">{session.house_number}</span></div>
              <div className="flex justify-between"><span className="text-slate-400">Amount</span><span className="text-white font-mono font-bold">${Number(session.amount).toFixed(2)}</span></div>
            </div>
            <p className="text-slate-500 text-xs">
              After completing the transfer, click below. A staff member will verify and confirm the payment within 1 business day.
            </p>
            {confirmError && (
              <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/30 text-red-400 rounded-lg p-3 text-sm">
                <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                <span>{confirmError}</span>
              </div>
            )}
            <button
              type="button"
              onClick={handleConfirm}
              disabled={confirming}
              className="btn-secondary w-full flex items-center justify-center gap-2"
            >
              {confirming ? (
                <><Loader2 className="w-4 h-4 animate-spin" /> Submitting…</>
              ) : (
                <><Building2 className="w-4 h-4" /> I've completed the transfer</>
              )}
            </button>
          </div>
        )}

        {/* ── Sahal / EVC USSD waiting state ───────────────────────────────── */}
        {isPending && ['sahal', 'evc'].includes(session.provider) && (
          <div className="card p-5 space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center flex-shrink-0">
                <Smartphone className="w-5 h-5 text-emerald-400" />
              </div>
              <div>
                <p className="text-white font-semibold text-sm">
                  {session.provider === 'sahal' ? 'Sahal' : 'EVC Plus'} Payment Pending
                </p>
                {session.phone_number && (
                  <p className="text-slate-400 text-xs font-mono">{session.phone_number}</p>
                )}
              </div>
            </div>

            {/* Live mode: waiting for real USSD approval */}
            {!session.metadata?.[`${session.provider}_mode`]?.includes('simulation') && (
              <div className="bg-slate-900/60 rounded-lg p-3 border border-slate-700/60 space-y-1 text-sm">
                <p className="text-slate-300">A USSD payment prompt has been sent to your phone.</p>
                <ol className="list-decimal list-inside text-slate-400 space-y-1 pl-1">
                  <li>Check your phone for a USSD prompt</li>
                  <li>Enter your {session.provider === 'sahal' ? 'Sahal' : 'EVC Plus'} PIN to approve</li>
                  <li>This page will update automatically</li>
                </ol>
              </div>
            )}

            {/* Simulation mode: show confirm button */}
            {(session.metadata?.sahal_mode === 'simulation' || session.metadata?.evc_mode === 'simulation') && (
              <div className="space-y-2">
                <p className="text-amber-400 text-sm font-medium">
                  Simulation mode — no real USSD sent.
                </p>
                {confirmError && (
                  <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/30 text-red-400 rounded-lg p-3 text-sm">
                    <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                    <span>{confirmError}</span>
                  </div>
                )}
                <button
                  type="button"
                  onClick={handleConfirm}
                  disabled={confirming}
                  className="btn-primary w-full flex items-center justify-center gap-2"
                >
                  {confirming ? (
                    <><Loader2 className="w-4 h-4 animate-spin" /> Processing…</>
                  ) : (
                    <><CheckCircle2 className="w-4 h-4" /> Simulate {session.provider === 'sahal' ? 'Sahal' : 'EVC'} Approval</>
                  )}
                </button>
              </div>
            )}

            <button onClick={fetchSession} className="text-slate-500 hover:text-slate-300 text-xs flex items-center gap-1">
              <RefreshCw className="w-3 h-3" /> Refresh status
            </button>
          </div>
        )}

        {/* ── Stripe redirect button ─────────────────────────────────────── */}
        {isPending && session.provider === 'stripe' && session.checkout_url && (
          <div className="card p-4 space-y-3">
            <p className="text-sm text-slate-300">
              You'll be redirected to Stripe's secure checkout to complete your payment.
            </p>
            <a
              href={session.checkout_url}
              className="btn-primary w-full flex items-center justify-center gap-2"
            >
              <CreditCard className="w-4 h-4" />
              Pay with Stripe
              <ExternalLink className="w-3.5 h-3.5 opacity-60" />
            </a>
          </div>
        )}

        {/* ── Stripe callback processing ─────────────────────────────────── */}
        {isPending && stripeStatus === 'success' && (
          <div className="card p-4 flex items-center gap-3">
            <Loader2 className="w-5 h-5 animate-spin text-blue-400 flex-shrink-0" />
            <div>
              <p className="text-white text-sm font-medium">Verifying your Stripe payment…</p>
              <p className="text-slate-400 text-xs">This usually takes a few seconds. Do not close this page.</p>
            </div>
          </div>
        )}

        {/* ── Success state ──────────────────────────────────────────────── */}
        {isCompleted && (
          <div className="card p-6 text-center space-y-4">
            <CheckCircle2 className="w-14 h-14 text-green-400 mx-auto" />
            <div>
              <h2 className="text-white font-bold text-lg">Payment Successful</h2>
              <p className="text-slate-400 text-sm mt-1">Your invoice has been marked as paid.</p>
            </div>
            {session.payment_reference && (
              <div className="bg-slate-900/60 rounded-lg p-3 border border-slate-700/60">
                <p className="text-slate-400 text-xs mb-1">Receipt Number</p>
                <p className="text-white font-mono font-bold text-lg">{session.payment_reference}</p>
              </div>
            )}
            <div className="flex flex-col gap-2">
              <a
                href={`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000'}/api/portal/receipt/${session.payment_reference}`}
                target="_blank"
                rel="noopener noreferrer"
                className="btn-secondary w-full flex items-center justify-center gap-2"
              >
                <Receipt className="w-4 h-4" /> View / Print Receipt
              </a>
              <a href="/pay" className="btn-ghost w-full text-center text-sm text-slate-400 hover:text-white">
                Pay another bill
              </a>
            </div>
          </div>
        )}

        {/* ── Failed / expired state ─────────────────────────────────────── */}
        {isFailed && (
          <div className="card p-6 text-center space-y-4">
            <XCircle className="w-12 h-12 text-red-400 mx-auto" />
            <div>
              <h2 className="text-white font-semibold text-lg">Payment Not Completed</h2>
              <p className="text-slate-400 text-sm mt-1">
                {session.status === 'expired'   && 'This payment session has expired.'}
                {session.status === 'cancelled' && 'This payment was cancelled.'}
                {session.status === 'failed'    && 'The payment could not be processed.'}
              </p>
            </div>
            <a href="/pay" className="btn-primary inline-flex items-center gap-2">
              Try again
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
