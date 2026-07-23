'use strict';

/**
 * abandonedCart.js — Scheduled job that detects and messages abandoned carts.
 *
 * Logic:
 *  • Runs every 5 minutes via node-cron
 *  • Iterates all stored checkouts
 *  • Skips those already reminded, already completed (order placed), or < 1 hour old
 *  • Sends a WhatsApp reminder and marks the checkout as "reminded"
 */

const cron = require('node-cron');
const store = require('./store');
const { sendWhatsAppMessage } = require('./whatsapp');
const logger = require('./logger');

const ABANDONED_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

// ── Core check ────────────────────────────────────────────────────────────────

async function checkAbandonedCarts() {
  const checkouts = store.getCheckoutsList();
  if (checkouts.length === 0) return;

  logger.info(`🔍 Abandoned cart check — scanning ${checkouts.length} checkout(s)…`);

  const now = Date.now();
  let remindersSent = 0;

  for (const checkout of checkouts) {
    try {
      // Already reminded — skip
      if (checkout.reminded) continue;

      // Order was placed — mark completed and skip
      const isCompleted =
        (checkout.checkoutToken && store.isCheckoutCompleted(checkout.checkoutToken)) ||
        store.isCheckoutCompleted(checkout.checkoutId);

      if (isCompleted) {
        store.upsertCheckout(checkout.checkoutId, {
          reminded: true,
          remindedAt: null,
          completedOrder: true,
        });
        continue;
      }

      // Not old enough yet
      const ageMs = now - new Date(checkout.timestamp).getTime();
      if (ageMs < ABANDONED_THRESHOLD_MS) continue;

      // No phone number — mark so we don't keep re-visiting
      if (!checkout.phone) {
        logger.warn(`Checkout ${checkout.checkoutId} has no phone — marking reminded`);
        store.markCheckoutReminded(checkout.checkoutId);
        continue;
      }

      // Build reminder message
      const customerName = checkout.customerName || 'there';
      const cartValue = checkout.totalPrice
        ? `${checkout.currency || 'USD'} ${checkout.totalPrice}`
        : 'your selected items';

      const itemLines = (checkout.lineItems || [])
        .slice(0, 5) // cap at 5 items to keep message concise
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

      logger.info(`Sending abandoned-cart reminder → checkout ${checkout.checkoutId}`);

      const result = await sendWhatsAppMessage(
        checkout.phone,
        message,
        'abandoned_cart',
        checkout.checkoutId
      );

      // Always mark reminded so we don't retry failed sends automatically
      store.markCheckoutReminded(checkout.checkoutId);

      if (result.success) {
        remindersSent++;
        logger.info(`✅ Reminder sent to ${checkout.phone} (checkout ${checkout.checkoutId})`);
      } else {
        logger.error(
          `❌ Reminder failed for checkout ${checkout.checkoutId}: ${result.error}`
        );
      }
    } catch (err) {
      logger.error(`Error processing checkout ${checkout.checkoutId}:`, {
        error: err.message,
      });
    }
  }

  logger.info(`✔ Abandoned cart check done — ${remindersSent} reminder(s) sent`);
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

function startAbandonedCartScheduler() {
  logger.info('⏱  Abandoned-cart scheduler started (runs every 5 minutes)');

  // Run immediately on startup, then on schedule
  checkAbandonedCarts().catch((err) =>
    logger.error('Initial abandoned-cart check failed:', { error: err.message })
  );

  cron.schedule('*/5 * * * *', async () => {
    try {
      await checkAbandonedCarts();
    } catch (err) {
      logger.error('Abandoned-cart scheduler error:', { error: err.message });
    }
  });
}

module.exports = { startAbandonedCartScheduler, checkAbandonedCarts };
