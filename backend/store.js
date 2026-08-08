'use strict';

/**
 * store.js — Central in-memory store with JSON file persistence.
 *
 * Sections:
 *   orders        – Shopify orders received via webhook
 *   checkouts     – Shopify checkouts (map keyed by checkoutId)
 *   messages      – WhatsApp message log
 *   completedIds  – Checkout tokens / IDs that became real orders
 *   settings      – Runtime-configurable credentials
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

/** @type {import('./types').Store} */
let store = buildDefault();

function buildDefault() {
  return {
    orders: [],
    checkouts: {},
    messages: [],
    completedIds: [], // checkout tokens / IDs linked to a completed order
    settings: {
      whatsappPhoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
      whatsappToken: process.env.WHATSAPP_TOKEN || '',
      shopifyStoreUrl: '',
      shopifyWebhookSecret: process.env.SHOPIFY_WEBHOOK_SECRET || '',
    },
  };
}

// ── Persistence ───────────────────────────────────────────────────────────────

function loadStore() {
  try {
    if (fs.existsSync(STORE_FILE)) {
      const raw = fs.readFileSync(STORE_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      store = {
        orders: parsed.orders || [],
        checkouts: parsed.checkouts || {},
        messages: parsed.messages || [],
        completedIds: parsed.completedIds || [],
        settings: { ...buildDefault().settings, ...(parsed.settings || {}) },
      };
    }
  } catch (err) {
    console.error('[store] Failed to load store.json, starting fresh:', err.message);
    store = buildDefault();
  }
}

// Debounced save — prevents excessive disk I/O during bulk operations
let saveTimer = null;
function saveStore() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2), 'utf8');
    } catch (err) {
      console.error('[store] Failed to save store.json:', err.message);
    }
  }, 300);
}

// Load on startup
loadStore();

// ── Orders ────────────────────────────────────────────────────────────────────

function getOrders() {
  return store.orders;
}

function addOrder(order) {
  store.orders.unshift(order);
  if (store.orders.length > 1000) store.orders = store.orders.slice(0, 1000);
  saveStore();
}

function updateOrderStatus(orderId, status) {
  const order = store.orders.find((o) => o.id === orderId);
  if (order) {
    order.whatsappStatus = status;
    saveStore();
  }
}

function getOrderById(orderId) {
  return store.orders.find((o) => o.id === orderId) || null;
}

// ── Checkouts ─────────────────────────────────────────────────────────────────

function getCheckouts() {
  return store.checkouts;
}

function getCheckoutsList() {
  return Object.values(store.checkouts);
}

function upsertCheckout(checkoutId, data) {
  store.checkouts[checkoutId] = {
    ...(store.checkouts[checkoutId] || {}),
    ...data,
  };
  saveStore();
}

function markCheckoutReminded(checkoutId) {
  if (store.checkouts[checkoutId]) {
    store.checkouts[checkoutId].reminded = true;
    store.checkouts[checkoutId].remindedAt = new Date().toISOString();
    saveStore();
  }
}

/** Record that a checkout token/id resulted in a real order (prevents cart reminders) */
function markCheckoutCompleted(tokenOrId) {
  if (tokenOrId && !store.completedIds.includes(tokenOrId)) {
    store.completedIds.push(tokenOrId);
    // Keep the list bounded
    if (store.completedIds.length > 5000) {
      store.completedIds = store.completedIds.slice(-5000);
    }
    saveStore();
  }
}

function isCheckoutCompleted(tokenOrId) {
  return store.completedIds.includes(tokenOrId);
}

// ── Messages ──────────────────────────────────────────────────────────────────

function getMessages() {
  return store.messages;
}

function addMessage(message) {
  store.messages.unshift(message);
  if (store.messages.length > 5000) store.messages = store.messages.slice(0, 5000);
  saveStore();
}

function updateMessageStatus(waMessageId, status) {
  const msg = store.messages.find((m) => m.id === waMessageId);
  if (msg) {
    msg.status = status;
    msg.updatedAt = new Date().toISOString();
    saveStore();
  }
}

// ── Settings ──────────────────────────────────────────────────────────────────

function getSettings() {
  return store.settings;
}

function updateSettings(updates) {
  store.settings = { ...store.settings, ...updates };
  saveStore();
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  // Orders
  getOrders,
  addOrder,
  updateOrderStatus,
  getOrderById,

  // Checkouts
  getCheckouts,
  getCheckoutsList,
  upsertCheckout,
  markCheckoutReminded,
  markCheckoutCompleted,
  isCheckoutCompleted,

  // Messages
  getMessages,
  addMessage,
  updateMessageStatus,

  // Settings
  getSettings,
  updateSettings,
};
