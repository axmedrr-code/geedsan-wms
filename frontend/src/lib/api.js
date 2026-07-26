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
  getTopConsumers: () => api.get('/dashboard/top-consumers'),
  // Extended billing/revenue endpoints
  getBillingStats: () => api.get('/dashboard/billing-stats'),
  getRevenueChart: (p) => api.get('/dashboard/revenue-chart', { params: p }),
  getTopCustomers: () => api.get('/dashboard/top-customers'),
  // Live operations dashboard
  getOpsStats: () => api.get('/dashboard/ops'),
};

export const metersAPI = {
  list: (p) => api.get('/meters', { params: p }),
  get: (id) => api.get(`/meters/${id}`),
  create: (d) => api.post('/meters', d),
  update: (id, d) => api.put(`/meters/${id}`, d),
  delete: (id) => api.delete(`/meters/${id}`),
  replaceMeter: (id, d) => api.post(`/meters/${id}/replace`, d),
  getReadings: (id, p) => api.get(`/meters/${id}/readings`, { params: p }),
  getPackets: (id, p) => api.get(`/meters/${id}/packets`, { params: p }),
  getSignal: (id, p) => api.get(`/meters/${id}/signal`, { params: p }),
  getConsumption: (id, p) => api.get(`/meters/${id}/consumption`, { params: p }),
  getBillingPeriodConsumption: (id, p) => api.get(`/meters/${id}/consumption/billing-period`, { params: p }),
  getHealth: (id) => api.get(`/meters/${id}/health`),
  getLeaks: (id, p) => api.get(`/meters/${id}/leaks`, { params: p }),
  detectLeaks: (id) => api.post(`/meters/${id}/leaks/detect`),
  updateLeak: (id, leakId, d) => api.patch(`/meters/${id}/leaks/${leakId}`, d),
};

export const gatewaysAPI = {
  list: () => api.get('/gateways'),
  get: (id) => api.get(`/gateways/${id}`),
  create: (d) => api.post('/gateways', d),
  update: (id, d) => api.put(`/gateways/${id}`, d),
  delete: (id) => api.delete(`/gateways/${id}`)
};

export const customersAPI = {
  list:       (p)      => api.get('/customers', { params: p }),
  get:        (id)     => api.get(`/customers/${id}`),
  create:     (d)      => api.post('/customers', d),
  update:     (id, d)  => api.put(`/customers/${id}`, d),
  delete:     (id)     => api.delete(`/customers/${id}`),
  getNotes:   (id)     => api.get(`/customers/${id}/notes`),
  addNote:    (id, d)  => api.post(`/customers/${id}/notes`, d),
  getActivity:(id)     => api.get(`/customers/${id}/activity`),
};

export const billingAPI = {
  list:          (p)      => api.get('/billing', { params: p }),
  get:           (id)     => api.get(`/billing/${id}`),
  create:        (d)      => api.post('/billing', d),
  update:        (id, d)  => api.put(`/billing/${id}`, d),
  recordPayment: (id, d)  => api.post(`/billing/${id}/payment`, d),
  getPayments:   (id)     => api.get(`/billing/${id}/payments`),
  // Real PDF generator (GET /billing/:id/pdf, keyed by invoice UUID). The
  // route requires an Authorization header, so this must be fetched through
  // the authenticated axios instance — a plain <a href> can't carry it.
  pdf:           (id)     => api.get(`/billing/${id}/pdf`, { responseType: 'blob' }),
  // Billing Center
  getSettings:    ()      => api.get('/billing/settings'),
  updateSettings: (d)     => api.put('/billing/settings', d),
  validate:       (p)     => api.get('/billing/validate', { params: p }),
  preview:        (p)     => api.get('/billing/preview', { params: p }),
  run:            (d)     => api.post('/billing/run', d),
  listRuns:       (p)     => api.get('/billing/runs', { params: p }),
  getRun:         (id)    => api.get(`/billing/runs/${id}`),
  cancelRun:      (id, d) => api.post(`/billing/runs/${id}/cancel`, d),
  postRun:        (id)    => api.post(`/billing/runs/${id}/post`),
  // Stats
  stats:          ()      => api.get('/billing/stats'),
  // Direct invoice generation
  generateForCustomer:  (id, d) => api.post(`/billing/generate/customer/${id}`, d),
  generateForZone:      (id, d) => api.post(`/billing/generate/zone/${id}`, d),
  generateForSelected:  (d)     => api.post('/billing/generate/selected', d),
};

export const tariffsAPI = {
  list:   ()          => api.get('/tariffs'),
  get:    (code)      => api.get(`/tariffs/${code}`),
  create: (d)         => api.post('/tariffs', d),
  update: (code, d)   => api.put(`/tariffs/${code}`, d),
};

export const billingReportsAPI = {
  customerStatement:    (id, p) => api.get(`/billing-reports/customer-statement/${id}`, { params: p }),
  customerStatementPdf: (id, p) => api.get(`/billing-reports/customer-statement/${id}/pdf`, { params: p, responseType: 'blob' }),
  zone:              (id, p) => api.get(`/billing-reports/zone/${id}`, { params: p }),
  aging:             ()      => api.get('/billing-reports/aging'),
  unpaid:            (p)     => api.get('/billing-reports/unpaid', { params: p }),
  consumption:       (p)     => api.get('/billing-reports/consumption', { params: p }),
  revenue:           (p)     => api.get('/billing-reports/revenue', { params: p }),
};

export const billingCyclesAPI = {
  list: (p) => api.get('/billing-cycles', { params: p }),
  get: (id) => api.get(`/billing-cycles/${id}`),
  create: (d) => api.post('/billing-cycles', d),
  postInvoice: (id, d) => api.post(`/billing-cycles/${id}/invoice`, d),
  recordPayment: (id, d) => api.post(`/billing-cycles/${id}/payment`, d)
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
  getCommands: () => api.get('/downlinks/commands'),
  getConfigFields: () => api.get('/downlinks/config-fields'),
  sendConfig: (d) => api.post('/downlinks/config', d)
};

export const reportsAPI = {
  list: () => api.get('/reports'),
  generate: (d) => api.post('/reports/generate', d),
  download: (id) => api.get(`/reports/${id}/download`, { responseType: 'blob' }),
  // Extended reports endpoints
  getSummary: () => api.get('/reports/summary'),
  getData: (p) => api.get('/reports/data', { params: p }),
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

// Public portal API — no auth headers, separate axios instance
const _publicApi = axios.create({ baseURL: `${API_BASE}/api/portal`, headers: { 'Content-Type': 'application/json' } });

export const portalAPI = {
  providers:       ()             => _publicApi.get('/providers'),
  lookup:          (houseNumber)  => _publicApi.get('/lookup', { params: { house_number: houseNumber } }),
  invoices:        (customerId)   => _publicApi.get(`/invoices/${customerId}`),
  checkout:        (d)            => _publicApi.post('/checkout', d),
  getSession:      (id)           => _publicApi.get(`/session/${id}`),
  confirmSession:  (id)           => _publicApi.post(`/session/${id}/confirm`),
  // Admin
  listSessions:    (p)            => api.get('/portal/sessions', { params: p }),
};

export const settingsAPI = {
  get:           ()       => api.get('/settings'),
  update:        (k, v)   => api.put(`/settings/${k}`, { value: v }),
  updateMany:    (s)      => api.put('/settings', { settings: s }),
  getBilling:    ()       => api.get('/settings/billing'),
  updateBilling: (d)      => api.put('/settings/billing', d),
  getSystemInfo: ()       => api.get('/settings/system-info'),
  getRolePerms:  ()       => api.get('/settings/role-permissions'),
  testEmail:     ()       => api.post('/settings/test/email'),
  testChirpStack:()       => api.post('/settings/test/chirpstack'),
  testOdoo:      ()       => api.post('/settings/test/odoo'),
  triggerBackup: ()       => api.post('/settings/backup'),
};

export const zonesAPI = {
  list:   (p)     => api.get('/zones', { params: p }),
  get:    (id)    => api.get(`/zones/${id}`),
  create: (d)     => api.post('/zones', d),
  update: (id, d) => api.put(`/zones/${id}`, d),
  delete: (id)    => api.delete(`/zones/${id}`),
};

export const paymentsAPI = {
  list:          (p)     => api.get('/payments', { params: p }),
  get:           (id)    => api.get(`/payments/${id}`),
  receipt:       (id)    => api.get(`/payments/${id}/receipt`),
  stats:         ()      => api.get('/payments/stats'),
  manualPayment: (d)     => api.post('/payments/manual', d),
  receiptUrl:    (id)    => `${API_BASE}/api/payments/${id}/receipt.html`,
};

export const odooAPI = {
  getStatus:      () => api.get('/odoo/status'),
  getQueue:       () => api.get('/odoo/queue'),
  processQueue:   () => api.post('/odoo/process-queue'),
  verifyInvoices: (p) => api.get('/odoo/verify-invoices', { params: p }),
  verifyPayments: (p) => api.get('/odoo/verify-payments', { params: p }),
};

export const systemAPI = {
  getHealth: () => api.get('/system/health')
};

export const usersAPI = {
  list: () => api.get('/users'),
  create: (d) => api.post('/users', d),
  update: (id, d) => api.put(`/users/${id}`, d),
  deactivate: (id) => api.delete(`/users/${id}`)
};

export default api;
