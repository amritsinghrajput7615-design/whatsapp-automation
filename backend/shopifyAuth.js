'use strict';

/**
 * shopifyAuth.js — Middleware that verifies Shopify webhook HMAC signatures.
 *
 * Shopify signs every webhook payload with HMAC-SHA256 using the webhook secret
 * and sends the base64-encoded digest in the X-Shopify-Hmac-Sha256 header.
 *
 * IMPORTANT: This middleware requires req.rawBody to be populated BEFORE the
 * JSON body parser runs (handled in server.js).
 */

const crypto = require('crypto');
const logger = require('./logger');
const store = require('./store');

/**
 * Express middleware — verify Shopify HMAC signature.
 */
function verifyShopifyWebhook(req, res, next) {
  const receivedHmac = req.headers['x-shopify-hmac-sha256'];

  if (!receivedHmac) {
    logger.warn('Webhook rejected: missing X-Shopify-Hmac-Sha256 header', {
      path: req.path,
      ip: req.ip,
    });
    return res.status(401).json({ error: 'Missing HMAC header' });
  }

  // Prefer runtime settings; fall back to environment variable
  const settings = store.getSettings();
  const secret =
    settings.shopifyWebhookSecret || process.env.SHOPIFY_WEBHOOK_SECRET;

  if (!secret) {
    logger.error('SHOPIFY_WEBHOOK_SECRET not configured — cannot verify webhook');
    return res.status(500).json({ error: 'Webhook secret not configured' });
  }

  if (!req.rawBody) {
    logger.error('req.rawBody not available — check server.js middleware order');
    return res.status(400).json({ error: 'Raw body unavailable for verification' });
  }

  const computed = crypto
    .createHmac('sha256', secret)
    .update(req.rawBody)
    .digest('base64');

  // Use timingSafeEqual to prevent timing attacks
  let valid = false;
  try {
    valid = crypto.timingSafeEqual(
      Buffer.from(computed, 'utf8'),
      Buffer.from(receivedHmac, 'utf8')
    );
  } catch {
    // Buffers were different lengths — definitely invalid
    valid = false;
  }

  if (!valid) {
    logger.warn('Webhook rejected: invalid HMAC signature', {
      path: req.path,
      topic: req.headers['x-shopify-topic'],
    });
    return res.status(401).json({ error: 'Invalid signature' });
  }

  logger.info('Shopify webhook signature verified ✓', {
    topic: req.headers['x-shopify-topic'],
    shop: req.headers['x-shopify-shop-domain'],
  });

  next();
}

module.exports = { verifyShopifyWebhook };
