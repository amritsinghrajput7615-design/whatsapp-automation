'use strict';

/**
 * store.js — Dual-persistence store (in-memory + JSON file + MongoDB).
 *
 * Read path  : Always served from in-memory (instant, synchronous).
 * Write path : Writes to in-memory immediately, then fans out to:
 *              • JSON file  (debounced 300 ms — always active, even without Mongo)
 *              • MongoDB    (async fire-and-forget — only when MONGODB_URI is set)
 *
 * On startup : JSON file is loaded first (fast). Once MongoDB connects, the
 *              in-memory store is hydrated from Atlas and the JSON file is
 *              re-synced with the authoritative cloud data.
 *
 * Exported function signatures are UNCHANGED — no other file needs updating.
 *
 * Sections:
 *   orders        – Shopify orders received via webhook
 *   checkouts     – Shopify checkouts (map keyed by checkoutId)
 *   messages      – WhatsApp message log
 *   completedIds  – Checkout tokens / IDs that became real orders
 *   settings      – Runtime-configurable credentials
 */

const fs   = require('fs');
const path = require('path');

// ── JSON-file persistence (fallback / local cache) ────────────────────────────

const DATA_DIR   = path.join(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function buildDefault() {
  return {
    orders:       [],
    checkouts:    {},
    messages:     [],
    completedIds: [],
    settings: {
      whatsappPhoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
      whatsappToken:         process.env.WHATSAPP_TOKEN           || '',
      shopifyStoreUrl:       '',
      shopifyWebhookSecret:  process.env.SHOPIFY_WEBHOOK_SECRET   || '',
    },
  };
}

/** @type {ReturnType<typeof buildDefault>} */
let mem = buildDefault();

function loadJson() {
  try {
    if (fs.existsSync(STORE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
      mem = {
        orders:       parsed.orders       || [],
        checkouts:    parsed.checkouts    || {},
        messages:     parsed.messages     || [],
        completedIds: parsed.completedIds || [],
        settings:     { ...buildDefault().settings, ...(parsed.settings || {}) },
      };
    }
  } catch (err) {
    console.error('[store] Failed to load store.json, starting fresh:', err.message);
    mem = buildDefault();
  }
}

let _saveTimer = null;
function saveJson() {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(STORE_FILE, JSON.stringify(mem, null, 2), 'utf8');
    } catch (err) {
      console.error('[store] Failed to write store.json:', err.message);
    }
  }, 300);
}

// Load JSON on startup — used immediately while MongoDB connects in background
loadJson();

// ── MongoDB (primary, optional) ───────────────────────────────────────────────

let mongoReady = false;
let Order, Checkout, Message, SettingDoc, CompletedIdDoc;

if (process.env.MONGODB_URI) {
  const mongoose = require('mongoose');
  const { Schema } = mongoose;

  // ── Schemas ────────────────────────────────────────────────────────────────

  Order = mongoose.model(
    'Order',
    new Schema({ id: { type: String, unique: true, index: true } },
    { strict: false, timestamps: true })
  );

  Checkout = mongoose.model(
    'Checkout',
    new Schema({ checkoutId: { type: String, unique: true, index: true } },
    { strict: false, timestamps: true })
  );

  Message = mongoose.model(
    'Message',
    new Schema(
      {
        id:        { type: String, unique: true, index: true },
        direction: String,
        phone:     String,
        body:      String,
        type:      String,
        status:    String,
        updatedAt: String,
        timestamp: String,
      },
      { strict: false, timestamps: true }
    )
  );

  SettingDoc = mongoose.model(
    'Setting',
    new Schema(
      {
        _id:                   { type: String, default: 'singleton' },
        whatsappPhoneNumberId: String,
        whatsappToken:         String,
        shopifyStoreUrl:       String,
        shopifyWebhookSecret:  String,
      },
      { _id: false }
    )
  );

  CompletedIdDoc = mongoose.model(
    'CompletedId',
    new Schema({ tokenOrId: { type: String, unique: true } })
  );

  // ── Hydrate in-memory store from MongoDB ───────────────────────────────────

  async function hydrateFromMongo() {
    try {
      const [orders, checkouts, messages, completedDocs, settings] = await Promise.all([
        Order.find().sort({ createdAt: -1 }).limit(1000).lean(),
        Checkout.find().lean(),
        Message.find().sort({ createdAt: -1 }).limit(5000).lean(),
        CompletedIdDoc.find().lean(),
        SettingDoc.findById('singleton').lean(),
      ]);

      mem.orders = orders;

      mem.checkouts = {};
      for (const c of checkouts) {
        mem.checkouts[c.checkoutId] = c;
      }

      mem.messages     = messages;
      mem.completedIds = completedDocs.map((d) => d.tokenOrId);

      if (settings) {
        mem.settings = {
          whatsappPhoneNumberId: settings.whatsappPhoneNumberId || mem.settings.whatsappPhoneNumberId,
          whatsappToken:         settings.whatsappToken         || mem.settings.whatsappToken,
          shopifyStoreUrl:       settings.shopifyStoreUrl       || mem.settings.shopifyStoreUrl,
          shopifyWebhookSecret:  settings.shopifyWebhookSecret  || mem.settings.shopifyWebhookSecret,
        };
      }

      // Re-sync JSON file to match authoritative cloud data
      saveJson();
      console.info('[store] ✅ In-memory store hydrated from MongoDB');
    } catch (err) {
      console.error('[store] Failed to hydrate from MongoDB:', err.message);
    }
  }

  // ── Connect ────────────────────────────────────────────────────────────────

  mongoose
    .connect(process.env.MONGODB_URI)
    .then(async () => {
      mongoReady = true;
      console.info('[store] ✅ MongoDB connected — using Atlas as primary store');
      await hydrateFromMongo();
    })
    .catch((err) => {
      console.error(
        '[store] ⚠️  MongoDB connection failed — falling back to JSON file:',
        err.message
      );
    });

  mongoose.connection.on('disconnected', () => {
    mongoReady = false;
    console.warn('[store] ⚠️  MongoDB disconnected — writes use JSON file only until reconnected');
  });

  mongoose.connection.on('reconnected', () => {
    mongoReady = true;
    console.info('[store] ✅ MongoDB reconnected');
  });
} else {
  console.info('[store] ℹ️  MONGODB_URI not set — running with JSON file persistence only');
}

/**
 * Fire-and-forget MongoDB write helper.
 * Errors are logged but never thrown, so they never affect the caller.
 * @param {() => Promise<any>} fn
 */
function tryMongo(fn) {
  if (!mongoReady) return;
  fn().catch((err) => console.error('[store] MongoDB write error:', err.message));
}

// ── Orders ────────────────────────────────────────────────────────────────────

function getOrders() {
  return mem.orders;
}

function addOrder(order) {
  mem.orders.unshift(order);
  if (mem.orders.length > 1000) mem.orders = mem.orders.slice(0, 1000);
  saveJson();
  tryMongo(() => Order.findOneAndUpdate({ id: order.id }, order, { upsert: true }));
}

function updateOrderStatus(orderId, status) {
  const order = mem.orders.find((o) => o.id === orderId);
  if (order) {
    order.whatsappStatus = status;
    saveJson();
    tryMongo(() =>
      Order.updateOne({ id: orderId }, { $set: { whatsappStatus: status } })
    );
  }
}

function getOrderById(orderId) {
  return mem.orders.find((o) => o.id === orderId) || null;
}

// ── Checkouts ─────────────────────────────────────────────────────────────────

function getCheckouts() {
  return mem.checkouts;
}

function getCheckoutsList() {
  return Object.values(mem.checkouts);
}

function upsertCheckout(checkoutId, data) {
  mem.checkouts[checkoutId] = {
    ...(mem.checkouts[checkoutId] || {}),
    ...data,
  };
  saveJson();
  tryMongo(() =>
    Checkout.findOneAndUpdate(
      { checkoutId },
      { checkoutId, ...data },
      { upsert: true, new: true }
    )
  );
}

function markCheckoutReminded(checkoutId) {
  if (mem.checkouts[checkoutId]) {
    const remindedAt = new Date().toISOString();
    mem.checkouts[checkoutId].reminded   = true;
    mem.checkouts[checkoutId].remindedAt = remindedAt;
    saveJson();
    tryMongo(() =>
      Checkout.updateOne(
        { checkoutId },
        { $set: { reminded: true, remindedAt } }
      )
    );
  }
}

function markCheckoutCompleted(tokenOrId) {
  if (tokenOrId && !mem.completedIds.includes(tokenOrId)) {
    mem.completedIds.push(tokenOrId);
    if (mem.completedIds.length > 5000) {
      mem.completedIds = mem.completedIds.slice(-5000);
    }
    saveJson();
    tryMongo(() =>
      CompletedIdDoc.findOneAndUpdate({ tokenOrId }, { tokenOrId }, { upsert: true })
    );
  }
}

function isCheckoutCompleted(tokenOrId) {
  return mem.completedIds.includes(tokenOrId);
}

// ── Messages ──────────────────────────────────────────────────────────────────

function getMessages() {
  return mem.messages;
}

function addMessage(message) {
  mem.messages.unshift(message);
  if (mem.messages.length > 5000) mem.messages = mem.messages.slice(0, 5000);
  saveJson();
  tryMongo(() =>
    Message.findOneAndUpdate({ id: message.id }, message, { upsert: true })
  );
}

function updateMessageStatus(waMessageId, status) {
  const msg = mem.messages.find((m) => m.id === waMessageId);
  if (msg) {
    msg.status    = status;
    msg.updatedAt = new Date().toISOString();
    saveJson();
    tryMongo(() =>
      Message.updateOne(
        { id: waMessageId },
        { $set: { status, updatedAt: msg.updatedAt } }
      )
    );
  }
}

// ── Settings ──────────────────────────────────────────────────────────────────

function getSettings() {
  return mem.settings;
}

function updateSettings(updates) {
  mem.settings = { ...mem.settings, ...updates };
  saveJson();
  tryMongo(() =>
    SettingDoc.findOneAndUpdate(
      { _id: 'singleton' },
      { _id: 'singleton', ...mem.settings },
      { upsert: true }
    )
  );
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
