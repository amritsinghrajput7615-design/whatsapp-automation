import client from './client';

export const api = {
  // ── Stats ────────────────────────────────────────────────────────────────
  getStats: () =>
    client.get('/api/stats').then((r) => r.data),

  // ── Orders ───────────────────────────────────────────────────────────────
  getOrders: (params = {}) =>
    client.get('/api/orders', { params }).then((r) => r.data),

  resendOrder: (id) =>
    client.post(`/api/orders/${id}/resend`).then((r) => r.data),

  // ── Abandoned Carts ───────────────────────────────────────────────────────
  getAbandonedCarts: () =>
    client.get('/api/abandoned-carts').then((r) => r.data),

  sendReminder: (id) =>
    client.post(`/api/abandoned-carts/${id}/remind`).then((r) => r.data),

  // ── Message Logs ──────────────────────────────────────────────────────────
  getMessages: (params = {}) =>
    client.get('/api/messages', { params }).then((r) => r.data),

  // ── Settings ─────────────────────────────────────────────────────────────
  getSettings: () =>
    client.get('/api/settings').then((r) => r.data),

  saveSettings: (data) =>
    client.post('/api/settings', data).then((r) => r.data),

  testWhatsApp: () =>
    client.post('/api/settings/test-whatsapp').then((r) => r.data),

  // ── Health ────────────────────────────────────────────────────────────────
  health: () =>
    client.get('/health').then((r) => r.data),
};
