import axios from 'axios';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000';

const api = axios.create({ baseURL: `${API_BASE}/api`, headers: { 'Content-Type': 'application/json' } });

api.interceptors.request.use((config) => {
  if (typeof window !== 'undefined') {
    const stored = localStorage.getItem('geedsan-auth');
    if (stored) {
      const auth = JSON.parse(stored);
      if (auth?.state?.accessToken) config.headers.Authorization = `Bearer ${auth.state.accessToken}`;
    }
  }
  return config;
});

api.interceptors.response.use(
  (r) => r,
  async (err) => {
    if (err.response?.status === 401 && !err.config._retry) {
      err.config._retry = true;
      try {
        const stored = JSON.parse(localStorage.getItem('geedsan-auth') || '{}');
        const rt = stored?.state?.refreshToken;
        if (rt) {
          const res = await axios.post(`${API_BASE}/api/auth/refresh`, { refreshToken: rt });
          const newToken = res.data.accessToken;
          const s = JSON.parse(localStorage.getItem('geedsan-auth'));
          s.state.accessToken = newToken;
          localStorage.setItem('geedsan-auth', JSON.stringify(s));
          err.config.headers.Authorization = `Bearer ${newToken}`;
          return api(err.config);
        }
      } catch { window.location.href = '/login'; }
    }
    return Promise.reject(err);
  }
);

export const authAPI = {
  login: (d) => api.post('/auth/login', d),
  refresh: (d) => api.post('/auth/refresh', d),
  me: () => api.get('/auth/me'),
  logout: () => api.post('/auth/logout'),
  changePassword: (d) => api.post('/auth/change-password', d)
};

export const dashboardAPI = {
  getStats: () => api.get('/dashboard/stats'),
  getConsumptionChart: (days) => api.get(`/dashboard/consumption-chart?days=${days}`),
  getAlarmSummary: () => api.get('/dashboard/alarm-summary'),
  getRecentAlarms: () => api.get('/dashboard/recent-alarms'),
  getDistribution: () => api.get('/dashboard/meter-distribution'),
  getTopConsumers: () => api.get('/dashboard/top-consumers')
};

export const metersAPI = {
  list: (p) => api.get('/meters', { params: p }),
  get: (id) => api.get(`/meters/${id}`),
  create: (d) => api.post('/meters', d),
  update: (id, d) => api.put(`/meters/${id}`, d),
  delete: (id) => api.delete(`/meters/${id}`),
  getReadings: (id, p) => api.get(`/meters/${id}/readings`, { params: p })
};

export const customersAPI = {
  list: (p) => api.get('/customers', { params: p }),
  get: (id) => api.get(`/customers/${id}`),
  create: (d) => api.post('/customers', d),
  update: (id, d) => api.put(`/customers/${id}`, d)
};

export const billingAPI = {
  list: (p) => api.get('/billing', { params: p }),
  get: (id) => api.get(`/billing/${id}`),
  create: (d) => api.post('/billing', d),
  update: (id, d) => api.put(`/billing/${id}`, d)
};

export const tankerAPI = {
  list: (p) => api.get('/tanker', { params: p }),
  get: (id) => api.get(`/tanker/${id}`),
  create: (d) => api.post('/tanker', d),
  update: (id, d) => api.put(`/tanker/${id}`, d)
};

export const alarmsAPI = {
  list: (p) => api.get('/alarms', { params: p }),
  acknowledge: (id) => api.post(`/alarms/${id}/acknowledge`),
  resolve: (id, d) => api.post(`/alarms/${id}/resolve`, d),
  create: (d) => api.post('/alarms', d),
  delete: (id) => api.delete(`/alarms/${id}`)
};

export const downlinksAPI = {
  sendValve: (d) => api.post('/downlinks/valve', d),
  list: (p) => api.get('/downlinks', { params: p }),
  getCommands: () => api.get('/downlinks/commands')
};

export const reportsAPI = {
  list: () => api.get('/reports'),
  generate: (d) => api.post('/reports/generate', d),
  download: (id) => api.get(`/reports/${id}/download`, { responseType: 'blob' })
};

export const aiAPI = {
  leakDetection: (meterId) => api.post('/ai/leak-detection', { meter_id: meterId }),
  forecast: (meterId, days) => api.post('/ai/consumption-forecast', { meter_id: meterId, days }),
  analyzeAlarm: (alarmId) => api.post('/ai/analyze-alarm', { alarm_id: alarmId }),
  getAnomalies: () => api.get('/ai/anomalies')
};

export const notificationsAPI = {
  getSettings: () => api.get('/notifications/settings'),
  saveSettings: (d) => api.post('/notifications/settings', d),
  getHistory: () => api.get('/notifications/history')
};

export const settingsAPI = {
  get: () => api.get('/settings'),
  update: (key, value) => api.put(`/settings/${key}`, { value }),
  updateMany: (settings) => api.put('/settings', { settings })
};

export const usersAPI = {
  list: () => api.get('/users'),
  create: (d) => api.post('/users', d),
  update: (id, d) => api.put(`/users/${id}`, d),
  deactivate: (id) => api.delete(`/users/${id}`)
};

export default api;
