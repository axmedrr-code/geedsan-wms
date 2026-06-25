import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { authAPI } from '../lib/api';

export const useAuthStore = create(
  persist(
    (set, get) => ({
      user: null,
      accessToken: null,
      refreshToken: null,
      isInitialized: false,

      login: async (username, password) => {
        const res = await authAPI.login({ username, password });
        const { user, accessToken, refreshToken } = res.data;
        set({ user, accessToken, refreshToken, isInitialized: true });
        return { user, accessToken, refreshToken };
      },

      logout: async () => {
        try { await authAPI.logout(); } catch {}
        set({ user: null, accessToken: null, refreshToken: null, isInitialized: true });
        if (typeof window !== 'undefined') window.location.href = '/login';
      },

      initialize: async () => {
        const { accessToken } = get();
        if (!accessToken) { set({ isInitialized: true }); return; }
        try {
          const res = await authAPI.me();
          set({ user: res.data.user, isInitialized: true });
        } catch {
          set({ user: null, accessToken: null, refreshToken: null, isInitialized: true });
        }
      },

      hasRole: (...roles) => roles.includes(get().user?.role)
    }),
    {
      name: 'geedsan-auth',
      partialize: (s) => ({ accessToken: s.accessToken, refreshToken: s.refreshToken, user: s.user })
    }
  )
);
