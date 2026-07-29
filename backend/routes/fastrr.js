'use strict';

/**
 * routes/fastrr.js — Express router for Shiprocket Fastrr webhook events.
 *
 * Webhook URL to register in Fastrr Dashboard:
 *   Solutions → Checkout → Webhooks → Add Webhook
 *   URL:    https://whatsapp-automation-3o94.onrender.com/webhooks/fastrr
 *   Events: Abandon Cart
 *   Header: Authorization: Bearer <FASTRR_WEBHOOK_SECRET>   (optional)
 *
 * DEBUG: hit GET /webhooks/fastrr/debug to see the last received raw payload.
 */

const express = require('express');
const router  = express.Router();
const logger  = require('../logger');
const {
  normalisePayload,
  handleAbandonedCart,
  handleOrderCreated,
} = require('../fastrr');

// In-memory store of the last raw payload received (for debugging)
let _lastRawPayload = null;

// ── Auth — LOG only, never silently drop ──────────────────────────────────────
// If FASTRR_WEBHOOK_SECRET is set we check it, but we still process the
// request and just log a warning on mismatch (avoids silent failures).
function softAuth(req, res, next) {
  const secret = process.env.FASTRR_WEBHOOK_SECRET;
  if (!secret || secret === 'your-fastrr-secret-here') {
    // Not configured — open access (dev/initial setup)
    return next();
  }
  const authHeader = req.headers['authorization'] || '';
  const provided   = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7).trim()
    : authHeader.trim();

  if (!provided) {
    logger.warn('[Fastrr] ⚠️  No Authorization header — processing anyway (check Fastrr dashboard header config)');
  } else if (provided !== secret) {
    logger.warn('[Fastrr] ⚠️  Authorization header mismatch — processing anyway', {
      provided: provided.slice(0, 6) + '***',
    });
  } else {
    logger.info('[Fastrr] ✅ Auth verified');
  }
  next(); // Always continue — never block Fastrr silently
}

// ── GET /webhooks/fastrr ──────────────────────────────────────────────────────
// Health-check / info endpoint (browser visits, Fastrr dashboard pings)

router.get('/', (req, res) => {
  const secret = process.env.FASTRR_WEBHOOK_SECRET;
  const authConfigured = secret && secret !== 'your-fastrr-secret-here';
  res.json({
    status:         'Fastrr webhook endpoint is reachable ✅',
    webhookUrl:     'https://whatsapp-automation-3o94.onrender.com/webhooks/fastrr',
    method:         'POST (Fastrr sends POST — this GET is for info only)',
    debugUrl:       'https://whatsapp-automation-3o94.onrender.com/webhooks/fastrr/debug',
    testUrl:        'https://whatsapp-automation-3o94.onrender.com/webhooks/fastrr/test',
    authConfigured,
    fastrrSetup: [
      'Go to: Shiprocket → Solutions → Checkout → Webhooks → Add Webhook',
      'Set URL: https://whatsapp-automation-3o94.onrender.com/webhooks/fastrr',
      'Select event: Abandon Cart',
      authConfigured
        ? 'Add Header → Authorization: Bearer <your FASTRR_WEBHOOK_SECRET>'
        : 'No auth header needed (FASTRR_WEBHOOK_SECRET not configured)',
    ],
  });
});

// ── POST /webhooks/fastrr ─────────────────────────────────────────────────────

router.post('/', softAuth, (req, res) => {
  // Store raw payload for debug inspection
  _lastRawPayload = {
    receivedAt: new Date().toISOString(),
    headers: {
      'content-type':  req.headers['content-type'],
      'authorization': req.headers['authorization']
        ? req.headers['authorization'].slice(0, 10) + '***'
        : '(none)',
      'user-agent':    req.headers['user-agent'],
    },
    body: req.body,
  };

  logger.info('[Fastrr] 📥 Raw webhook received', {
    bodyKeys: Object.keys(req.body || {}),
    rawBody:  JSON.stringify(req.body).slice(0, 300),
  });

  // Acknowledge immediately
  res.status(200).json({ received: true });

  // Process async
  setImmediate(async () => {
    try {
      const data  = normalisePayload(req.body);
      const event = data.event;

      logger.info(`[Fastrr] Processing event: "${event}"`, {
        checkoutId: data.checkoutId,
        phone:      data.phone,
        total:      `${data.currency} ${data.totalPrice}`,
        items:      data.lineItems?.length,
      });

      // Fastrr sometimes sends no "event" field — every POST to this
      // URL is an abandoned cart by definition, so treat unknown as one.
      switch (event) {
        case 'abandoned_cart':
        case 'checkout_abandoned':
        case 'unknown':              // ← no event field = it IS an abandoned cart
          await handleAbandonedCart(data);
          break;

        case 'order_created':
        case 'checkout_completed':
        case 'purchase':
          await handleOrderCreated(data);
          break;

        default:
          logger.warn(`[Fastrr] Unrecognised event "${event}" — treating as abandoned_cart`);
          await handleAbandonedCart(data);
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

router.get('/test', (req, res) => {
  const secret = process.env.FASTRR_WEBHOOK_SECRET;
  const authConfigured = secret && secret !== 'your-fastrr-secret-here';

  res.json({
    status:         'Fastrr webhook endpoint is reachable ✅',
    webhookUrl:     `https://whatsapp-automation-3o94.onrender.com/webhooks/fastrr`,
    debugUrl:       `https://whatsapp-automation-3o94.onrender.com/webhooks/fastrr/debug`,
    authConfigured,
    fastrrSetup: [
      'Go to: Shiprocket → Solutions → Checkout → Webhooks → Add Webhook',
      `Set URL: https://whatsapp-automation-3o94.onrender.com/webhooks/fastrr`,
      'Select event: Abandon Cart',
      authConfigured
        ? 'Add Header → Authorization: Bearer <your FASTRR_WEBHOOK_SECRET>'
        : 'No auth header needed (FASTRR_WEBHOOK_SECRET not configured)',
    ],
  });
});

// ── GET /webhooks/fastrr/debug ────────────────────────────────────────────────
// Shows the last raw payload received from Fastrr.
// Use this to confirm Fastrr is hitting your server and see the exact payload.

router.get('/debug', (req, res) => {
  if (!_lastRawPayload) {
    return res.json({
      message: 'No webhook received yet from Fastrr.',
      hint: 'Go to Fastrr dashboard → Webhooks → click "Test" or wait for a real abandoned cart.',
    });
  }
  res.json({
    message: 'Last Fastrr webhook payload received:',
    ..._lastRawPayload,
  });
});

module.exports = router;
