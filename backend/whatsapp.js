'use strict';

/**
 * whatsapp.js — WhatsApp Cloud API helper.
 *
 * Exports:
 *   normalizePhone(phone, defaultCountryCode)                       → string | null
 *   sendWhatsAppMessage(to, message, messageType, referenceId)      → Promise<Result>
 *   sendWhatsAppTemplate(to, templateName, langCode, components,
 *                        messageType, referenceId)                  → Promise<Result>
 *
 * WHY TEMPLATES?
 *  WhatsApp only allows free-form text WITHIN a 24-hour customer-service window
 *  (i.e. after the customer messages YOU first).  For proactive outbound messages
 *  such as abandoned-cart reminders you MUST use a pre-approved template — Meta
 *  accepts the API call either way and returns a wamid, but silently drops the
 *  message if it violates the policy.  Use sendWhatsAppTemplate() for all
 *  abandoned-cart / order-confirmation flows.
 */

const axios = require('axios');
const logger = require('./logger');
const store = require('./store');

const GRAPH_API_VERSION = 'v20.0';
const GRAPH_API_BASE = 'https://graph.facebook.com';

// ── Phone normalisation ───────────────────────────────────────────────────────

/**
 * Normalise a phone number to WhatsApp format: digits only, no leading "+".
 *
 * Rules applied in order:
 *  1. Strip non-digit characters (spaces, dashes, parentheses, "+")
 *  2. If starts with "00" strip those leading zeros (international dial prefix)
 *  3. If exactly 10 digits, prepend the defaultCountryCode
 *  4. Reject numbers with fewer than 7 digits
 *
 * @param {string} phone
 * @param {string} [defaultCountryCode='1']  Digits only, no "+"
 * @returns {string|null}
 */
function normalizePhone(phone, defaultCountryCode) {
  if (!phone) return null;

  const cc = defaultCountryCode || process.env.DEFAULT_COUNTRY_CODE || '1';

  // Remove every non-digit character
  let digits = String(phone).replace(/\D/g, '');

  // International prefix "00…" → strip the "00"
  if (digits.startsWith('00')) {
    digits = digits.slice(2);
  }

  // Sanity-check minimum length
  if (digits.length < 7) return null;

  // 10 digits → assume local number, prepend country code
  if (digits.length === 10) {
    digits = cc + digits;
  }

  return digits;
}

// ── Message sending ───────────────────────────────────────────────────────────

/**
 * Send an APPROVED WhatsApp message template via Meta Cloud API.
 *
 * This is the correct way to initiate proactive conversations (abandoned carts,
 * order confirmations, etc.).  Free-form text messages sent outside a 24-hour
 * customer-service window are silently dropped by Meta even though a wamid
 * is returned.
 *
 * @param {string}   to            Recipient phone (any format; will be normalised)
 * @param {string}   templateName  Exact template name as approved in WhatsApp Manager
 * @param {string}   [langCode]    Language code (default: 'en' — change if template is in another language)
 * @param {Array}    [components]  Template variable components (header/body/button params)
 * @param {string}   [messageType] For logging: 'abandoned_cart' | 'order_confirmation' | etc.
 * @param {string}   [referenceId] Checkout/order ID for log correlation
 * @returns {Promise<{success: boolean, waMessageId?: string, waId?: string, data?: object, error?: string}>}
 */
async function sendWhatsAppTemplate(
  to,
  templateName,
  langCode     = 'en',
  components   = [],
  messageType  = 'template',
  referenceId  = null
) {
  const normalizedPhone = normalizePhone(to);

  if (!normalizedPhone) {
    const errMsg = `Invalid phone number: "${to}"`;
    logger.error(errMsg, { messageType, referenceId });
    _recordMessage(to, `[template:${templateName}]`, messageType, referenceId, 'failed', errMsg);
    return { success: false, error: errMsg };
  }

  const settings       = store.getSettings();
  const token          = settings.whatsappToken          || process.env.WHATSAPP_TOKEN;
  const phoneNumberId  = settings.whatsappPhoneNumberId  || process.env.WHATSAPP_PHONE_NUMBER_ID;

  if (!token || !phoneNumberId) {
    const errMsg = 'WhatsApp token or Phone Number ID is not configured';
    logger.error(errMsg);
    _recordMessage(normalizedPhone, `[template:${templateName}]`, messageType, referenceId, 'failed', errMsg);
    return { success: false, error: errMsg };
  }

  const url     = `${GRAPH_API_BASE}/${GRAPH_API_VERSION}/${phoneNumberId}/messages`;
  const payload = {
    messaging_product: 'whatsapp',
    to:   normalizedPhone,
    type: 'template',
    template: {
      name:       templateName,
      language:   { code: langCode },
      ...(components.length > 0 ? { components } : {}),
    },
  };

  logger.info(`📤 Sending WhatsApp template "${templateName}" → ${normalizedPhone}`, {
    messageType, referenceId, langCode,
  });

  try {
    const response    = await axios.post(url, payload, {
      headers: {
        Authorization:  `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      timeout: 12000,
    });

    const waMessageId = response.data?.messages?.[0]?.id;
    const waId        = response.data?.contacts?.[0]?.wa_id;

    logger.info(`✅ WhatsApp template "${templateName}" accepted for ${normalizedPhone}`, {
      waMessageId, waId, messageType,
      note: 'wamid accepted — actual delivery confirmed via status webhook',
    });

    _recordMessage(normalizedPhone, `[template:${templateName}]`, messageType, referenceId, 'sent', null);
    return { success: true, waMessageId, waId, data: response.data };
  } catch (err) {
    const errorMessage = _extractErrorMessage(err);
    logger.error(`❌ WhatsApp template send failed to ${normalizedPhone}: ${errorMessage}`, {
      messageType, referenceId, templateName,
    });
    _recordMessage(normalizedPhone, `[template:${templateName}]`, messageType, referenceId, 'failed', errorMessage);
    return { success: false, error: errorMessage };
  }
}

/**
 * Send a plain-text WhatsApp message via Meta Cloud API.
 *
 * ⚠️  Only works within the 24-hour customer-service window (i.e. the customer
 *     messaged YOUR number first).  For proactive outbound use sendWhatsAppTemplate().
 *
 * @param {string}  to           Recipient phone (any format; will be normalised)
 * @param {string}  message      Message body
 * @param {string}  [messageType='manual']
 * @param {string|null} [referenceId]
 * @returns {Promise<{success: boolean, data?: object, error?: string}>}
 */
async function sendWhatsAppMessage(
  to,
  message,
  messageType = 'manual',
  referenceId = null
) {
  const normalizedPhone = normalizePhone(to);

  if (!normalizedPhone) {
    const errMsg = `Invalid / un-normalizable phone number: "${to}"`;
    logger.error(errMsg, { messageType, referenceId });
    _recordMessage(to, message, messageType, referenceId, 'failed', errMsg);
    return { success: false, error: errMsg };
  }

  const settings = store.getSettings();
  const token = settings.whatsappToken || process.env.WHATSAPP_TOKEN;
  const phoneNumberId =
    settings.whatsappPhoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID;

  if (!token || !phoneNumberId) {
    const errMsg = 'WhatsApp token or Phone Number ID is not configured';
    logger.error(errMsg);
    _recordMessage(normalizedPhone, message, messageType, referenceId, 'failed', errMsg);
    return { success: false, error: errMsg };
  }

  const url = `${GRAPH_API_BASE}/${GRAPH_API_VERSION}/${phoneNumberId}/messages`;
  const payload = {
    messaging_product: 'whatsapp',
    to: normalizedPhone,
    type: 'text',
    text: { body: message },
  };

  logger.info(`📤 Sending WhatsApp free-text → ${normalizedPhone}`, {
    messageType,
    referenceId,
    chars: message.length,
    warning: 'Free-text only works within 24h customer-service window — use template for proactive messages',
  });

  try {
    const response = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      timeout: 12000,
    });

    const waMessageId = response.data?.messages?.[0]?.id;
    const waId        = response.data?.contacts?.[0]?.wa_id;
    logger.info(`✅ WhatsApp free-text accepted for ${normalizedPhone}`, {
      waMessageId, waId, messageType,
    });

    _recordMessage(normalizedPhone, message, messageType, referenceId, 'sent', null);
    return { success: true, data: response.data };
  } catch (err) {
    const errorMessage = _extractErrorMessage(err);
    logger.error(`❌ WhatsApp send failed to ${normalizedPhone}: ${errorMessage}`, {
      messageType,
      referenceId,
    });
    _recordMessage(normalizedPhone, message, messageType, referenceId, 'failed', errorMessage);
    return { success: false, error: errorMessage };
  }
}

// ── Private helpers ───────────────────────────────────────────────────────────

function _extractErrorMessage(err) {
  if (err.response) {
    const apiErr = err.response.data?.error;
    if (apiErr) {
      return `Meta API ${apiErr.code} (${apiErr.type}): ${apiErr.message}`;
    }
    return `HTTP ${err.response.status} ${err.response.statusText}`;
  }
  if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
    return 'Request timed out';
  }
  return err.message || 'Unknown error';
}

function _recordMessage(to, message, type, referenceId, status, error) {
  store.addMessage({
    id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    to,
    message,
    type,
    referenceId,
    status,
    error: error || null,
    timestamp: new Date().toISOString(),
  });
}

module.exports = { sendWhatsAppMessage, sendWhatsAppTemplate, normalizePhone };
