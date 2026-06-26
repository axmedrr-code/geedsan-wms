'use client';
import { useParams, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { tankerAPI } from '../../../../lib/api';
import { ArrowLeft, Truck } from 'lucide-react';

export default function TankerDetailPage() {
  const { id } = useParams();
  const router = useRouter();

  const { data, isLoading } = useQuery({
    queryKey: ['tanker-detail', id],
    queryFn: () => tankerAPI.get(id).then(r => r.data),
    enabled: !!id
  });

  const delivery = data?.delivery;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64"><div className="w-8 h-8 border-2 border-primary-500/30 border-t-primary-500 rounded-full animate-spin" /></div>
    );
  }

  if (!delivery) return <div className="p-6 text-slate-400">Delivery not found</div>;

  return (
    <div className="p-4 lg:p-6 space-y-6 animate-fade-in">
      <div className="flex items-center justify-between gap-4">
        <button onClick={() => router.back()} className="btn-secondary text-sm flex items-center gap-2"><ArrowLeft className="w-4 h-4" /> Back</button>
        <div>
          <p className="text-slate-400 text-sm">Tanker delivery details</p>
          <h1 className="text-2xl font-bold text-white font-display">{delivery.delivery_reference}</h1>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className="card-glow p-5">
          <h2 className="text-sm uppercase tracking-[0.2em] text-slate-500 mb-4">Customer</h2>
          <p className="text-white font-semibold">{delivery.customer_name}</p>
          <p className="text-slate-400 text-sm">{delivery.customer_number}</p>
          <p className="mt-4 text-slate-400 text-sm">{delivery.customer_phone}</p>
        </div>
        <div className="card-glow p-5">
          <div className="space-y-3">
            <div>
              <p className="text-slate-400 text-xs uppercase">Scheduled</p>
              <p className="text-white font-medium">{new Date(delivery.scheduled_at).toLocaleDateString()}</p>
            </div>
            <div>
              <p className="text-slate-400 text-xs uppercase">Status</p>
              <p className="text-white font-medium capitalize">{delivery.status}</p>
            </div>
          </div>
        </div>
        <div className="card-glow p-5">
          <div className="space-y-3">
            <div>
              <p className="text-slate-400 text-xs uppercase">Volume</p>
              <p className="text-white font-medium">{delivery.delivery_volume} L</p>
            </div>
            <div>
              <p className="text-slate-400 text-xs uppercase">Vehicle</p>
              <p className="text-white font-medium">{delivery.vehicle_number || '—'}</p>
            </div>
          </div>
        </div>
      </div>

      <div className="card-glow p-5">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold text-white">Delivery Information</h2>
            <p className="text-slate-500 text-sm">Scheduled tanker dispatch overview.</p>
          </div>
          <Truck className="w-5 h-5 text-primary-400" />
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div>
            <p className="text-slate-400 text-xs uppercase">Driver</p>
            <p className="text-white font-medium">{delivery.driver_name}</p>
          </div>
          <div>
            <p className="text-slate-400 text-xs uppercase">Address</p>
            <p className="text-white font-medium">{delivery.delivery_address || '—'}</p>
          </div>
        </div>
        {delivery.notes && (
          <div className="mt-4">
            <p className="text-slate-400 text-xs uppercase">Notes</p>
            <p className="text-white mt-2">{delivery.notes}</p>
          </div>
        )}
      </div>
    </div>
  );
}
