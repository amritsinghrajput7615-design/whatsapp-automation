'use strict';

/**
 * routes/fastrr.js — Express router for Shiprocket Fastrr webhook events.
 *
 * Registered in server.js as:
 *   app.use('/webhooks/fastrr', require('./routes/fastrr'));
 *
 * Register this URL in Fastrr Dashboard:
 *   Solutions → Checkout → Webhooks → Add Webhook
 *   URL:    https://YOUR_DOMAIN/webhooks/fastrr
 *   Events: abandoned_cart, order_created
 *   Header: Authorization: Bearer <FASTRR_WEBHOOK_SECRET>
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EVENTS HANDLED
 * ─────────────────────────────────────────────────────────────────────────────
 *  abandoned_cart  → Send WhatsApp reminder immediately
 *  order_created   → Mark cart completed (prevents Shopify scheduler duplicate)
 *  (anything else) → Acknowledge with 200, log and ignore
 */

const express = require('express');
const router  = express.Router();
const logger  = require('../logger');
const {
  verifyFastrrWebhook,
  normalisePayload,
  handleAbandonedCart,
  handleOrderCreated,
} = require('../fastrr');

// ── POST /webhooks/fastrr ─────────────────────────────────────────────────────

router.post('/', verifyFastrrWebhook, (req, res) => {
  // Acknowledge Fastrr immediately — same pattern as Shopify webhooks
  res.status(200).json({ received: true });

  // Process asynchronously so we never time out Fastrr's delivery attempt
  setImmediate(async () => {
    try {
      const data  = normalisePayload(req.body);
      const event = data.event;

      logger.info(`[Fastrr] Webhook received: ${event}`, {
        checkoutId: data.checkoutId,
        phone:      data.phone,
        total:      `${data.currency} ${data.totalPrice}`,
      });

      switch (event) {
        case 'abandoned_cart':
        case 'checkout_abandoned':   // alternate event name used by some accounts
          await handleAbandonedCart(data);
          break;

        case 'order_created':
        case 'checkout_completed':   // alternate event name
          await handleOrderCreated(data);
          break;

        default:
          logger.info(`[Fastrr] Unhandled event "${event}" — ignoring`);
      }
    } catch (err) {
      logger.error('[Fastrr] Error processing webhook:', {
        error: err.message,
        stack: err.stack,
      });
    }
  });
});

// ── GET /webhooks/fastrr/test ─────────────────────────────────────────────────
// Convenience endpoint — lets you verify the route is reachable without
// needing a valid Authorization header (useful during ngrok setup).

router.get('/test', (req, res) => {
  res.json({
    status:  'Fastrr webhook endpoint is reachable ✅',
    url:     `${req.protocol}://${req.get('host')}/webhooks/fastrr`,
    instructions: [
      '1. Register the URL above in Fastrr Dashboard → Solutions → Checkout → Webhooks',
      '2. Select events: abandoned_cart, order_created',
      '3. Add header  →  Authorization: Bearer <FASTRR_WEBHOOK_SECRET>',
      '4. Set FASTRR_WEBHOOK_SECRET in backend/.env to the same value',
    ],
  });
});

module.exports = router;
