'use strict';

/**
 * routes/webhooks.js — Shopify webhook endpoints.
 *
 * All routes are protected by verifyShopifyWebhook middleware.
 * Shopify requires a 200 response within 5 s, so we acknowledge first,
 * then process asynchronously.
 */

const express = require('express');
const router = express.Router();
const { verifyShopifyWebhook } = require('../shopifyAuth');
const { sendWhatsAppMessage } = require('../whatsapp');
const store = require('../store');
const logger = require('../logger');

// ── POST /webhooks/orders-create ──────────────────────────────────────────────

router.post('/orders-create', verifyShopifyWebhook, (req, res) => {
  logger.info('📦 Webhook received: orders/create');
  res.status(200).send('OK'); // acknowledge immediately

  setImmediate(() => handleOrderCreate(req.body));
});

async function handleOrderCreate(order) {
  try {
    const orderId = String(order.id);
    const orderNumber = order.order_number || order.name || orderId;
    const currency = order.currency || 'USD';
    const orderTotal = `${currency} ${parseFloat(order.total_price || 0).toFixed(2)}`;

    const customerName = order.customer
      ? [order.customer.first_name, order.customer.last_name]
          .filter(Boolean)
          .join(' ') || 'Customer'
      : 'Customer';

    const phone =
      order.billing_address?.phone ||
      order.shipping_address?.phone ||
      order.customer?.phone ||
      order.phone ||
      null;

    const lineItems = (order.line_items || []).map((i) => ({
      title: i.title,
      quantity: i.quantity,
      price: i.price,
      variantTitle: i.variant_title || '',
    }));

    // Prevent abandoned-cart reminders for this checkout
    if (order.checkout_token) store.markCheckoutCompleted(order.checkout_token);
    if (order.checkout_id) store.markCheckoutCompleted(String(order.checkout_id));

    // Persist order
    store.addOrder({
      id: orderId,
      orderNumber,
      customerName,
      phone,
      total: orderTotal,
      currency,
      lineItems,
      whatsappStatus: 'pending',
      timestamp: order.created_at || new Date().toISOString(),
    });

    logger.info(`Order #${orderNumber} stored`, { orderId, customerName, phone });

    if (!phone) {
      logger.warn(`Order #${orderNumber}: no phone number — skipping WhatsApp`);
      store.updateOrderStatus(orderId, 'no_phone');
      return;
    }

    const itemLines = lineItems
      .slice(0, 8)
      .map((i) => `• ${i.title} × ${i.quantity}`)
      .join('\n');

    const message =
      `✅ *Order Confirmed!*\n\n` +
      `Hi ${customerName}, your order has been placed! 🎉\n\n` +
      `🧾 Order: #${orderNumber}\n` +
      `💰 Total: ${orderTotal}\n\n` +
      `*Items ordered:*\n${itemLines}\n\n` +
      `We'll notify you as soon as your order ships. Thank you for shopping with us! 🚚`;

    const result = await sendWhatsAppMessage(
      phone,
      message,
      'order_confirmation',
      orderId
    );

    store.updateOrderStatus(orderId, result.success ? 'sent' : 'failed');
  } catch (err) {
    logger.error('handleOrderCreate error:', { error: err.message, stack: err.stack });
  }
}

// ── POST /webhooks/checkouts-create ──────────────────────────────────────────

router.post('/checkouts-create', verifyShopifyWebhook, (req, res) => {
  logger.info('🛒 Webhook received: checkouts/create');
  res.status(200).send('OK');

  setImmediate(() => handleCheckout(req.body));
});

// ── POST /webhooks/checkouts-update ──────────────────────────────────────────

router.post('/checkouts-update', verifyShopifyWebhook, (req, res) => {
  logger.info('🛒 Webhook received: checkouts/update');
  res.status(200).send('OK');

  setImmediate(() => handleCheckout(req.body));
});

// ── Shared checkout handler ───────────────────────────────────────────────────

async function handleCheckout(checkout) {
  try {
    const checkoutId = String(checkout.id);
    const existing = store.getCheckouts()[checkoutId] || {};

    const phone =
      checkout.billing_address?.phone ||
      checkout.shipping_address?.phone ||
      checkout.phone ||
      existing.phone ||
      null;

    const customerName =
      (checkout.customer
        ? [checkout.customer.first_name, checkout.customer.last_name]
            .filter(Boolean)
            .join(' ')
        : null) ||
      checkout.email ||
      existing.customerName ||
      null;

    const lineItems = (checkout.line_items || []).map((i) => ({
      title: i.title,
      quantity: i.quantity,
      price: i.price,
      variantTitle: i.variant_title || '',
    }));

    store.upsertCheckout(checkoutId, {
      checkoutId,
      checkoutToken: checkout.token || existing.checkoutToken,
      phone,
      customerName,
      email: checkout.email || existing.email,
      lineItems,
      totalPrice: checkout.total_price || existing.totalPrice,
      currency: checkout.currency || existing.currency,
      abandonedCheckoutUrl:
        checkout.abandoned_checkout_url || existing.abandonedCheckoutUrl,
      // Preserve original timestamp (don't reset on update)
      timestamp: existing.timestamp || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      reminded: existing.reminded || false,
    });

    logger.info(`Checkout ${checkoutId} upserted`, {
      phone,
      customerName,
      items: lineItems.length,
    });
  } catch (err) {
    logger.error('handleCheckout error:', { error: err.message });
  }
}

module.exports = router;
