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
const { sendWhatsAppMessage, sendWhatsAppTemplate } = require('./whatsapp');
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

      // Build reminder message (used for free-text fallback only)
      const customerName = checkout.customerName || 'there';
      const cartValue = checkout.totalPrice
        ? `${checkout.currency || 'INR'} ${checkout.totalPrice}`
        : 'your selected items';

      const itemLines = (checkout.lineItems || [])
        .slice(0, 5)
        .map((i) => `• ${i.title} × ${i.quantity}`)
        .join('\n');

      const urlLine = checkout.abandonedCheckoutUrl
        ? `\n\n🔗 ${checkout.abandonedCheckoutUrl}`
        : '';

      const fallbackMessage =
        `Hi ${customerName}! 🛒 You left something behind!\n\n` +
        `Items worth ${cartValue} are still in your cart:\n` +
        `${itemLines || '• Your cart items'}\n\n` +
        `Complete your purchase before they sell out! 🛍️${urlLine}`;

      logger.info(`Sending abandoned-cart reminder → checkout ${checkout.checkoutId}`);

      // ── Use approved template for proactive outbound messages ───────────────────
      const templateName = process.env.WHATSAPP_ABANDONED_CART_TEMPLATE;
      const langCode     = process.env.WHATSAPP_TEMPLATE_LANG || 'en';

      let result;

      if (templateName) {
        // ── Map to your approved "abandoned_cart_reminder" template ──
        //
        // Template body:
        //   Hi {{1}}, you left {{2}} in your cart!
        //   Complete your order now before it sells out.
        //   Your cart total: {{3}}
        //   Prices may change if items go out of stock.
        //
        // Button: "Visit website" (dynamic URL suffix only — NOT the full URL).
        //   Meta requires only the dynamic suffix after the static base URL that
        //   was set when the template was created in WhatsApp Manager.
        //   Set WHATSAPP_TEMPLATE_URL_BASE to that static base (e.g.
        //   "https://amritsinghrajput.myshopify.com/") so we can strip it.
        //   If the env var is absent the button component is omitted and the
        //   body message still delivers.

        const cartTotal = checkout.totalPrice
          ? `${checkout.currency || 'INR'} ${parseFloat(checkout.totalPrice).toFixed(2)}`
          : 'your selected items';

        const firstItem = (checkout.lineItems || [])[0]?.title || 'your items';

        // Compute the dynamic URL suffix for the button component.
        const urlSuffix = _buttonSuffix(checkout.abandonedCheckoutUrl);

        const components = [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: customerName || 'there' },  // {{1}} name
              { type: 'text', text: firstItem               },  // {{2}} item
              { type: 'text', text: cartTotal               },  // {{3}} total
            ],
          },
          // "Visit website" URL button — only included when a suffix is available
          ...(urlSuffix ? [{
            type: 'button',
            sub_type: 'url',
            index: '0',
            parameters: [
              { type: 'text', text: urlSuffix },
            ],
          }] : []),
        ];
        result = await sendWhatsAppTemplate(
          checkout.phone, templateName, langCode, components,
          'abandoned_cart', checkout.checkoutId
        );
      } else {
        logger.warn(
          `Checkout ${checkout.checkoutId}: WHATSAPP_ABANDONED_CART_TEMPLATE not set — ` +
          'using free-text (silently dropped by Meta outside 24h window)'
        );
        result = await sendWhatsAppMessage(
          checkout.phone, fallbackMessage, 'abandoned_cart', checkout.checkoutId
        );
      }

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

// ── URL button helper ─────────────────────────────────────────────────────────

/**
 * Return the dynamic URL suffix expected by a WhatsApp URL-button component.
 *
 * Meta requires the button parameter to contain ONLY the part of the URL that
 * comes after the static base URL configured when the template was created
 * in WhatsApp Manager.  Sending the full URL causes error 132018.
 *
 * Configure WHATSAPP_TEMPLATE_URL_BASE to your store's base URL, e.g.:
 *   WHATSAPP_TEMPLATE_URL_BASE=https://amritsinghrajput.myshopify.com/
 *
 * If the env var is not set, or the checkout URL doesn't start with the base,
 * returns null — the button component will be omitted from the template call
 * so the body message still delivers without triggering a 132018 error.
 *
 * @param {string|undefined} checkoutUrl  Full abandoned-checkout URL from Shopify
 * @returns {string|null}
 */
function _buttonSuffix(checkoutUrl) {
  if (!checkoutUrl) return null;

  const base = (process.env.WHATSAPP_TEMPLATE_URL_BASE || '').trim();

  if (!base) {
    // No base configured — cannot compute suffix safely; skip the button.
    logger.warn(
      'WHATSAPP_TEMPLATE_URL_BASE is not set — URL button omitted from template. ' +
      'Set it to your store base URL (e.g. https://yourstore.myshopify.com/) to enable the button.'
    );
    return null;
  }

  if (!checkoutUrl.startsWith(base)) {
    // URL doesn't match the configured base — skip the button to avoid 132018.
    logger.warn(
      `Checkout URL "${checkoutUrl}" does not start with WHATSAPP_TEMPLATE_URL_BASE "${base}" — ` +
      'URL button omitted.'
    );
    return null;
  }

  const suffix = checkoutUrl.slice(base.length);
  return suffix || null;
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
