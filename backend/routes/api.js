'use strict';

/**
 * routes/api.js — Dashboard REST API consumed by the React frontend.
 *
 * GET  /api/stats
 * GET  /api/orders
 * POST /api/orders/:id/resend
 * GET  /api/abandoned-carts
 * POST /api/abandoned-carts/:id/remind
 * GET  /api/messages
 * GET  /api/settings
 * POST /api/settings
 * POST /api/settings/test-whatsapp
 *
 * ── Shopify Admin API (live data via Client Credentials OAuth) ──
 * GET  /api/shopify/status          — token health + shop info
 * GET  /api/shopify/products        — first N products (GraphQL)
 * GET  /api/shopify/orders          — recent orders  (GraphQL)
 * POST /api/shopify/graphql         — pass-through GraphQL proxy
 */

const express = require('express');
const router = express.Router();
const axios = require('axios');
const store = require('../store');
const { sendWhatsAppMessage } = require('../whatsapp');
const { checkAbandonedCarts } = require('../abandonedCart');
const logger = require('../logger');
const shopify = require('../shopifyClient');

// ── GET /api/stats ────────────────────────────────────────────────────────────

router.get('/stats', (req, res) => {
  try {
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0]; // 'YYYY-MM-DD'

    const orders = store.getOrders();
    const messages = store.getMessages();
    const checkouts = store.getCheckoutsList();

    const ordersToday = orders.filter((o) =>
      o.timestamp?.startsWith(todayStr)
    ).length;

    const abandonedCarts = checkouts.filter(
      (c) => !c.reminded && !c.completedOrder
    ).length;

    const messagesSent = messages.filter((m) => m.status === 'sent').length;
    const messagesFailed = messages.filter((m) => m.status === 'failed').length;

    // Messages per day — last 7 days
    const messagesPerDay = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(now);
      d.setDate(d.getDate() - (6 - i));
      const dateStr = d.toISOString().split('T')[0];
      return {
        date: dateStr,
        sent: messages.filter(
          (m) => m.status === 'sent' && m.timestamp?.startsWith(dateStr)
        ).length,
        failed: messages.filter(
          (m) => m.status === 'failed' && m.timestamp?.startsWith(dateStr)
        ).length,
      };
    });

    res.json({
      ordersToday,
      abandonedCarts,
      messagesSent,
      messagesFailed,
      messagesPerDay,
    });
  } catch (err) {
    logger.error('GET /api/stats error:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// ── GET /api/orders ───────────────────────────────────────────────────────────

router.get('/orders', (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    const orders = store.getOrders();
    const start = (page - 1) * limit;

    res.json({
      orders: orders.slice(start, start + limit),
      total: orders.length,
      page,
      limit,
      pages: Math.ceil(orders.length / limit),
    });
  } catch (err) {
    logger.error('GET /api/orders error:', err);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// ── POST /api/orders/:id/resend ───────────────────────────────────────────────

router.post('/orders/:id/resend', async (req, res) => {
  try {
    const order = store.getOrderById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (!order.phone)
      return res.status(400).json({ error: 'Order has no phone number' });

    const itemLines = (order.lineItems || [])
      .slice(0, 8)
      .map((i) => `• ${i.title} × ${i.quantity}`)
      .join('\n');

    const message =
      `✅ *Order Confirmed!*\n\n` +
      `Hi ${order.customerName}, your order has been placed! 🎉\n\n` +
      `🧾 Order: #${order.orderNumber}\n` +
      `💰 Total: ${order.total}\n\n` +
      `*Items ordered:*\n${itemLines}\n\n` +
      `Thank you for shopping with us! 🚚`;

    logger.info(`Resending WhatsApp for order ${order.orderNumber}`);
    const result = await sendWhatsAppMessage(
      order.phone,
      message,
      'order_confirmation',
      order.id
    );

    store.updateOrderStatus(order.id, result.success ? 'sent' : 'failed');

    res.json({
      success: result.success,
      error: result.error || null,
      order: store.getOrderById(order.id),
    });
  } catch (err) {
    logger.error('POST /api/orders/:id/resend error:', err);
    res.status(500).json({ error: 'Failed to resend message' });
  }
});

// ── GET /api/abandoned-carts ──────────────────────────────────────────────────

router.get('/abandoned-carts', (req, res) => {
  try {
    const now = Date.now();
    const ONE_HOUR = 60 * 60 * 1000;

    const carts = store
      .getCheckoutsList()
      .map((c) => {
        const ageMs = now - new Date(c.timestamp).getTime();
        const ageMinutes = Math.floor(ageMs / 60000);
        const ageHours = Math.floor(ageMinutes / 60);
        const ageDays = Math.floor(ageHours / 24);

        const timeSince =
          ageDays > 0
            ? `${ageDays}d ${ageHours % 24}h ago`
            : ageHours > 0
            ? `${ageHours}h ${ageMinutes % 60}m ago`
            : `${ageMinutes}m ago`;

        return {
          ...c,
          ageMs,
          timeSince,
          isAbandoned: !c.completedOrder && ageMs >= ONE_HOUR,
          reminderStatus: c.completedOrder
            ? 'completed'
            : c.reminded
            ? 'sent'
            : ageMs >= ONE_HOUR
            ? 'pending'
            : 'too_soon',
        };
      })
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    res.json({ abandonedCarts: carts, total: carts.length });
  } catch (err) {
    logger.error('GET /api/abandoned-carts error:', err);
    res.status(500).json({ error: 'Failed to fetch abandoned carts' });
  }
});

// ── POST /api/abandoned-carts/:id/remind ─────────────────────────────────────

router.post('/abandoned-carts/:id/remind', async (req, res) => {
  try {
    const checkoutId = req.params.id;
    const checkout = store.getCheckouts()[checkoutId];

    if (!checkout) return res.status(404).json({ error: 'Checkout not found' });
    if (!checkout.phone)
      return res.status(400).json({ error: 'Checkout has no phone number' });

    const customerName = checkout.customerName || 'there';
    const cartValue = checkout.totalPrice
      ? `${checkout.currency || 'USD'} ${checkout.totalPrice}`
      : 'your selected items';

    const itemLines = (checkout.lineItems || [])
      .slice(0, 5)
      .map((i) => `• ${i.title} × ${i.quantity}`)
      .join('\n');

    const urlLine = checkout.abandonedCheckoutUrl
      ? `\n\n🔗 ${checkout.abandonedCheckoutUrl}`
      : '';

    const message =
      `Hi ${customerName}! 🛒 You left something behind!\n\n` +
      `Items worth ${cartValue} are still in your cart:\n` +
      `${itemLines || '• Your cart items'}\n\n` +
      `Complete your purchase before they sell out! 🛍️${urlLine}`;

    const result = await sendWhatsAppMessage(
      checkout.phone,
      message,
      'abandoned_cart',
      checkoutId
    );

    store.markCheckoutReminded(checkoutId);

    res.json({
      success: result.success,
      error: result.error || null,
      checkout: store.getCheckouts()[checkoutId],
    });
  } catch (err) {
    logger.error('POST /api/abandoned-carts/:id/remind error:', err);
    res.status(500).json({ error: 'Failed to send reminder' });
  }
});

// ── GET /api/messages ─────────────────────────────────────────────────────────

router.get('/messages', (req, res) => {
  try {
    const { status, startDate, endDate } = req.query;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 100));

    let msgs = store.getMessages();

    if (status && status !== 'all') {
      msgs = msgs.filter((m) => m.status === status);
    }
    if (startDate) {
      msgs = msgs.filter((m) => m.timestamp >= startDate);
    }
    if (endDate) {
      msgs = msgs.filter(
        (m) => m.timestamp <= endDate + 'T23:59:59.999Z'
      );
    }

    const start = (page - 1) * limit;
    res.json({
      messages: msgs.slice(start, start + limit),
      total: msgs.length,
      page,
      limit,
      pages: Math.ceil(msgs.length / limit),
    });
  } catch (err) {
    logger.error('GET /api/messages error:', err);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// ── GET /api/settings ─────────────────────────────────────────────────────────

router.get('/settings', (req, res) => {
  try {
    const s = store.getSettings();
    // Never expose full secrets — return masked versions + boolean flags
    res.json({
      whatsappPhoneNumberId: s.whatsappPhoneNumberId || '',
      whatsappToken: s.whatsappToken
        ? '••••••••' + s.whatsappToken.slice(-6)
        : '',
      shopifyStoreUrl: s.shopifyStoreUrl || '',
      shopifyWebhookSecret: s.shopifyWebhookSecret
        ? '••••••••' + s.shopifyWebhookSecret.slice(-6)
        : '',
      _hasToken: !!s.whatsappToken,
      _hasSecret: !!s.shopifyWebhookSecret,
    });
  } catch (err) {
    logger.error('GET /api/settings error:', err);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// ── POST /api/settings ────────────────────────────────────────────────────────

router.post('/settings', (req, res) => {
  try {
    const {
      whatsappPhoneNumberId,
      whatsappToken,
      shopifyStoreUrl,
      shopifyWebhookSecret,
    } = req.body;

    const updates = {};
    if (whatsappPhoneNumberId !== undefined)
      updates.whatsappPhoneNumberId = whatsappPhoneNumberId;
    if (shopifyStoreUrl !== undefined)
      updates.shopifyStoreUrl = shopifyStoreUrl;
    // Only overwrite secrets if the user sent a non-masked value
    if (whatsappToken && !whatsappToken.startsWith('••'))
      updates.whatsappToken = whatsappToken;
    if (shopifyWebhookSecret && !shopifyWebhookSecret.startsWith('••'))
      updates.shopifyWebhookSecret = shopifyWebhookSecret;

    store.updateSettings(updates);
    logger.info('Settings updated via dashboard');
    res.json({ success: true, message: 'Settings saved' });
  } catch (err) {
    logger.error('POST /api/settings error:', err);
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

// ── POST /api/settings/test-whatsapp ─────────────────────────────────────────

router.post('/settings/test-whatsapp', async (req, res) => {
  try {
    const s = store.getSettings();
    const token = s.whatsappToken || process.env.WHATSAPP_TOKEN;
    const phoneNumberId =
      s.whatsappPhoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID;

    if (!token || !phoneNumberId) {
      return res.status(400).json({
        success: false,
        error: 'WhatsApp token or Phone Number ID is not configured',
      });
    }

    // Verify by fetching phone number metadata from Meta Graph API
    const response = await axios.get(
      `https://graph.facebook.com/v20.0/${phoneNumberId}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 10000,
      }
    );

    res.json({
      success: true,
      phoneNumber: response.data.display_phone_number,
      verifiedName: response.data.verified_name,
      qualityRating: response.data.quality_rating,
    });
  } catch (err) {
    const apiError = err.response?.data?.error;
    const errorMsg = apiError
      ? `${apiError.message} (Code: ${apiError.code})`
      : err.message;

    logger.warn('WhatsApp connection test failed:', { error: errorMsg });
    res.status(400).json({ success: false, error: errorMsg });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// ── SHOPIFY ADMIN API ROUTES (Client Credentials OAuth) ──────────────────────
// ═════════════════════════════════════════════════════════════════════════════

// ── GET /api/shopify/status ───────────────────────────────────────────────────
// Returns token health and basic shop info. Safe to call frequently.

router.get('/shopify/status', async (req, res) => {
  if (!shopify.isConfigured()) {
    return res.json({
      configured: false,
      message: 'Set SHOPIFY_SHOP, SHOPIFY_CLIENT_ID, and SHOPIFY_CLIENT_SECRET in .env',
    });
  }

  try {
    const data = await shopify.graphql('{ shop { name email myshopifyDomain plan { displayName } } }');
    res.json({
      configured: true,
      token: shopify.tokenStatus(),
      shop: data.shop,
    });
  } catch (err) {
    logger.error('GET /api/shopify/status error:', { error: err.message });
    res.status(502).json({ configured: true, error: err.message });
  }
});

// ── GET /api/shopify/products ─────────────────────────────────────────────────
// Returns up to `limit` products (default 10, max 50) via GraphQL.

router.get('/shopify/products', async (req, res) => {
  if (!shopify.isConfigured()) {
    return res.status(503).json({ error: 'Shopify client not configured' });
  }

  try {
    const first = Math.min(50, Math.max(1, parseInt(req.query.limit) || 10));
    const query = `
      query GetProducts($first: Int!) {
        products(first: $first) {
          edges {
            node {
              id
              title
              handle
              status
              totalInventory
              priceRangeV2 {
                minVariantPrice { amount currencyCode }
                maxVariantPrice { amount currencyCode }
              }
              featuredImage { url altText }
              createdAt
              updatedAt
            }
          }
        }
      }
    `;
    const data = await shopify.graphql(query, { first });
    const products = data.products.edges.map((e) => e.node);
    res.json({ products, total: products.length });
  } catch (err) {
    logger.error('GET /api/shopify/products error:', { error: err.message });
    res.status(502).json({ error: err.message });
  }
});

// ── GET /api/shopify/orders ───────────────────────────────────────────────────
// Returns the most recent `limit` orders (default 10, max 50) via GraphQL.

router.get('/shopify/orders', async (req, res) => {
  if (!shopify.isConfigured()) {
    return res.status(503).json({ error: 'Shopify client not configured' });
  }

  try {
    const first = Math.min(50, Math.max(1, parseInt(req.query.limit) || 10));
    const query = `
      query GetOrders($first: Int!) {
        orders(first: $first, reverse: true) {
          edges {
            node {
              id
              name
              createdAt
              displayFinancialStatus
              displayFulfillmentStatus
              totalPriceSet { shopMoney { amount currencyCode } }
              customer { displayName phone email }
              lineItems(first: 5) {
                edges { node { title quantity } }
              }
            }
          }
        }
      }
    `;
    const data = await shopify.graphql(query, { first });
    const orders = data.orders.edges.map((e) => e.node);
    res.json({ orders, total: orders.length });
  } catch (err) {
    logger.error('GET /api/shopify/orders error:', { error: err.message });
    res.status(502).json({ error: err.message });
  }
});

// ── POST /api/shopify/graphql ─────────────────────────────────────────────────
// Pass-through GraphQL proxy. Body: { query: string, variables?: object }
// Useful for ad-hoc queries from the frontend without adding new backend routes.

router.post('/shopify/graphql', async (req, res) => {
  if (!shopify.isConfigured()) {
    return res.status(503).json({ error: 'Shopify client not configured' });
  }

  const { query, variables } = req.body;
  if (!query) {
    return res.status(400).json({ error: '"query" field is required in request body' });
  }

  try {
    const data = await shopify.graphql(query, variables || {});
    res.json({ data });
  } catch (err) {
    logger.error('POST /api/shopify/graphql error:', { error: err.message });
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
