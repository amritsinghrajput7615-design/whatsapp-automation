'use strict';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  fastrr.js — Shiprocket Fastrr Checkout integration module              ║
 * ║                                                                          ║
 * ║  TO REMOVE FASTRR ENTIRELY:                                              ║
 * ║    1. Delete this file (backend/fastrr.js)                               ║
 * ║    2. Delete backend/routes/fastrr.js                                    ║
 * ║    3. Remove the ONE line in server.js that mounts the Fastrr route      ║
 * ║       (search: "fastrr" in server.js)                                    ║
 * ║    4. Remove FASTRR_* vars from .env                                     ║
 * ║  That's it — zero changes to any other file.                             ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * WHY FASTRR EXISTS ALONGSIDE SHOPIFY ABANDONED CART:
 *  Fastrr is Shiprocket's checkout overlay. When customers use it they bypass
 *  Shopify's native checkout flow, meaning Shopify's checkouts/create and
 *  checkouts/update webhooks NEVER fire for those sessions.
 *  Fastrr fires its own "abandoned_cart" event directly to our server instead.
 *
 * AUTH STRATEGY:
 *  In your Fastrr dashboard (Solutions → Checkout → Webhooks → Add Webhook)
 *  set a custom Header:
 *    Key:   Authorization
 *    Value: Bearer <your-FASTRR_WEBHOOK_SECRET value>
 *  Our server verifies that header on every incoming request.
 *
 * PAYLOAD STRUCTURE (what Fastrr POSTs to us):
 * {
 *   "event": "abandoned_cart",          // or "order_created"
 *   "id": "fastrr_checkout_id",
 *   "token": "cart_token_abc123",
 *   "phone": "919876543210",            // always 10-13 digits, no +
 *   "email": "customer@email.com",
 *   "first_name": "Rahul",
 *   "last_name": "Sharma",
 *   "currency": "INR",
 *   "total_price": "1299.00",
 *   "abandoned_checkout_url": "https://store.myshopify.com/...",
 *   "line_items": [
 *     { "title": "Product", "variant_title": "M / Blue",
 *       "quantity": 2, "price": "649.50", "image_url": "..." }
 *   ]
 * }
 */

const logger = require('./logger');
const store  = require('./store');
const { sendWhatsAppMessage } = require('./whatsapp');

// ── Auth verification middleware ──────────────────────────────────────────────

/**
 * Verifies the Authorization: Bearer <FASTRR_WEBHOOK_SECRET> header.
 * Returns 401 if missing or wrong. Pass-through if FASTRR_WEBHOOK_SECRET
 * is not set (dev-mode: skip auth so you can test with curl).
 */
function verifyFastrrWebhook(req, res, next) {
  const secret = process.env.FASTRR_WEBHOOK_SECRET;

  if (!secret) {
    logger.warn(
      '[Fastrr] FASTRR_WEBHOOK_SECRET not set — skipping auth (dev mode)'
    );
    return next();
  }

  const authHeader = req.headers['authorization'] || '';
  const provided   = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7).trim()
    : '';

  if (!provided || provided !== secret) {
    logger.warn('[Fastrr] Webhook rejected — invalid Authorization header', {
      ip: req.ip,
    });
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
}

// ── Payload normaliser ────────────────────────────────────────────────────────

/**
 * Extracts a clean, consistent object from the raw Fastrr payload.
 * Field names differ slightly across Fastrr API versions — this absorbs that.
 */
function normalisePayload(body) {
  return {
    event:               body.event || 'unknown',
    checkoutId:          String(body.cart_token || body.token || body.cart_id || body.checkout_id || body.id || ''),
    cartToken:           body.cart_token || body.token || '',
    phone:               body.phone || body.phone_number || '',
    email:               body.email || '',
    firstName:           body.first_name  || '',
    lastName:            body.last_name   || '',
    customerName:        [body.first_name, body.last_name].filter(Boolean).join(' ') || body.name || 'there',
    currency:            body.currency    || 'INR',
    totalPrice:          body.total_price || body.total_amount || '0',
    abandonedCheckoutUrl: body.abandoned_checkout_url || '',
    lineItems: (body.line_items || body.items || []).map((i) => ({
      title:        i.title || i.name || 'Product',
      variantTitle: i.variant_title || i.variant || '',
      quantity:     i.quantity || 1,
      price:        i.price   || '0',
      imageUrl:     i.image_url || i.image || '',
    })),
  };
}

// ── Message builder ───────────────────────────────────────────────────────────

/**
 * Builds a WhatsApp abandoned-cart reminder from a normalised Fastrr payload.
 */
function buildAbandonedCartMessage(data) {
  const { customerName, currency, totalPrice, lineItems, abandonedCheckoutUrl } = data;

  const cartValue = totalPrice && parseFloat(totalPrice) > 0
    ? `${currency} ${parseFloat(totalPrice).toFixed(2)}`
    : 'your selected items';

  const itemLines = lineItems
    .slice(0, 5)
    .map((i) => {
      const variant = i.variantTitle ? ` (${i.variantTitle})` : '';
      return `• ${i.title}${variant} × ${i.quantity}`;
    })
    .join('\n');

  const urlLine = abandonedCheckoutUrl
    ? `\n\n🔗 Resume checkout: ${abandonedCheckoutUrl}`
    : '';

  return (
    `Hi ${customerName}! 🛒 Your cart is waiting!\n\n` +
    `You left items worth *${cartValue}* behind:\n` +
    `${itemLines || '• Your cart items'}\n\n` +
    `Complete your order now before it sells out! 🛍️${urlLine}`
  );
}

// ── Core handler functions ────────────────────────────────────────────────────

/**
 * Handle Fastrr "abandoned_cart" event.
 * Stores the checkout (reusing the same store as Shopify carts),
 * then sends a WhatsApp reminder immediately.
 * (No 1-hour delay — Fastrr already applies its own timing logic before
 *  firing the webhook, so by the time we receive it the cart IS abandoned.)
 */
async function handleAbandonedCart(data) {
  const { checkoutId, cartToken, phone, email, customerName,
          currency, totalPrice, lineItems, abandonedCheckoutUrl } = data;

  if (!checkoutId) {
    logger.warn('[Fastrr] abandoned_cart event missing checkout ID — skipping');
    return;
  }

  // Persist in the shared store (same structure as Shopify carts)
  store.upsertCheckout(checkoutId, {
    checkoutId,
    checkoutToken: cartToken,
    phone,
    email,
    customerName,
    currency,
    totalPrice,
    lineItems,
    abandonedCheckoutUrl,
    source: 'fastrr',          // ← distinguishes Fastrr carts from Shopify carts
    timestamp: new Date().toISOString(),
    reminded: false,
  });

  logger.info(`[Fastrr] Abandoned cart stored: ${checkoutId}`, {
    phone, customerName, items: lineItems.length,
  });

  if (!phone) {
    logger.warn(`[Fastrr] No phone on checkout ${checkoutId} — cannot WhatsApp`);
    store.markCheckoutReminded(checkoutId);
    return;
  }

  const message = buildAbandonedCartMessage(data);
  const result  = await sendWhatsAppMessage(
    phone, message, 'abandoned_cart', checkoutId
  );

  store.markCheckoutReminded(checkoutId);

  if (result.success) {
    logger.info(`[Fastrr] ✅ Reminder sent to ${phone}`);
  } else {
    logger.error(`[Fastrr] ❌ Reminder failed for ${checkoutId}: ${result.error}`);
  }
}

/**
 * Handle Fastrr "order_created" event.
 * Marks the corresponding checkout as completed so Shopify's abandoned-cart
 * scheduler (abandonedCart.js) doesn't send a duplicate reminder.
 */
async function handleOrderCreated(data) {
  const { checkoutId, cartToken, phone, customerName } = data;

  logger.info(`[Fastrr] Order created — marking cart ${checkoutId} as completed`, {
    phone, customerName,
  });

  if (checkoutId) store.markCheckoutCompleted(checkoutId);
  if (cartToken)  store.markCheckoutCompleted(cartToken);
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  verifyFastrrWebhook,
  normalisePayload,
  handleAbandonedCart,
  handleOrderCreated,
  buildAbandonedCartMessage,
};
