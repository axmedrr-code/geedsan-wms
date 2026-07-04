'use client';
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000';

// Subscribes to the backend's SSE telemetry/alarm stream and invalidates the
// given react-query keys live, so dashboards update without waiting for the
// next poll. Polling stays on as a fallback if the SSE connection drops.
export function useRealtimeEvents(queryKeys = []) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const stored = localStorage.getItem('geedsan-auth');
    const token = stored ? JSON.parse(stored)?.state?.accessToken : null;
    if (!token) return;

    const source = new EventSource(`${API_BASE}/api/realtime/events?token=${token}`);

    const invalidate = () => queryKeys.forEach(key => queryClient.invalidateQueries({ queryKey: key }));
    source.addEventListener('telemetry', invalidate);
    source.addEventListener('alarm', invalidate);
    source.onerror = () => {
      // EventSource auto-reconnects; polling already covers the gap meanwhile.
    };

    return () => source.close();
  }, [queryClient, JSON.stringify(queryKeys)]);
}
