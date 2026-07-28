'use strict';

/**
 * routes/meta.js — Meta WhatsApp Cloud API webhook handler.
 *
 * TWO jobs:
 *
 * 1. GET  /webhooks/meta  ← Verification handshake (one-time setup)
 *    Meta sends:  ?hub.mode=subscribe&hub.verify_token=XXX&hub.challenge=YYY
 *    We respond:  hub.challenge value (proves we own this URL)
 *
 * 2. POST /webhooks/meta  ← Live events from Meta
 *    - Message status updates: sent / delivered / read / failed
 *    - Incoming customer replies (if they reply to your WhatsApp)
 *
 * SETUP IN META DASHBOARD:
 *   Callback URL : https://YOUR_DOMAIN/webhooks/meta
 *   Verify token : (whatever you set as META_VERIFY_TOKEN in .env)
 *   Subscriptions: messages, message_deliveries, message_reads
 */

const express = require('express');
const router  = express.Router();
const logger  = require('../logger');
const store   = require('../store');

// ── GET /webhooks/meta ── Verification handshake ──────────────────────────────
// Meta calls this once when you click "Verify and save" in the dashboard.

router.get('/', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  const expectedToken = process.env.META_VERIFY_TOKEN;

  if (!expectedToken) {
    logger.error('[Meta] META_VERIFY_TOKEN is not set in .env');
    return res.status(500).send('Server misconfigured: META_VERIFY_TOKEN not set');
  }

  if (mode === 'subscribe' && token === expectedToken) {
    logger.info('[Meta] ✅ Webhook verified successfully by Meta');
    return res.status(200).send(challenge); // Must return ONLY the challenge string
  }

  logger.warn('[Meta] ❌ Webhook verification failed — token mismatch', {
    provided: token,
    expected: expectedToken ? '(set)' : '(not set)',
  });
  return res.status(403).send('Forbidden');
});

// ── POST /webhooks/meta ── Live events from Meta ──────────────────────────────
// Meta sends message status updates and incoming customer messages here.

router.post('/', (req, res) => {
  // Always acknowledge immediately — Meta retries if it doesn't get 200
  res.sendStatus(200);

  setImmediate(() => {
    try {
      const body = req.body;

      if (body.object !== 'whatsapp_business_account') return;

      for (const entry of body.entry || []) {
        for (const change of entry.changes || []) {
          const value = change.value;

          // ── Incoming customer messages ─────────────────────────────────────
          if (value.messages?.length) {
            for (const msg of value.messages) {
              const from = msg.from; // sender's phone number
              const text = msg.type === 'text' ? msg.text?.body : `[${msg.type}]`;

              logger.info(`[Meta] 📩 Incoming message from ${from}: ${text}`, {
                messageId: msg.id,
                timestamp: msg.timestamp,
              });

              // Log it in the store so the dashboard can show it
              store.addMessage({
                id:         msg.id,
                direction:  'inbound',
                phone:      from,
                body:       text,
                type:       msg.type,
                status:     'received',
                timestamp:  new Date(Number(msg.timestamp) * 1000).toISOString(),
              });
            }
          }

          // ── Message status updates (sent/delivered/read/failed) ────────────
          if (value.statuses?.length) {
            for (const status of value.statuses) {
              const { id, status: statusVal, recipient_id, timestamp } = status;

              logger.info(
                `[Meta] 📬 Status update: ${statusVal} → ${recipient_id}`,
                { messageId: id }
              );

              // Update the matching outbound log entry in the store
              store.updateMessageStatus(id, statusVal);

              // Log failed deliveries at warn level for visibility
              if (statusVal === 'failed') {
                const errCode = status.errors?.[0]?.code;
                const errMsg  = status.errors?.[0]?.message || 'Unknown error';
                logger.warn(
                  `[Meta] ❌ Message delivery FAILED to ${recipient_id}`,
                  { messageId: id, errorCode: errCode, error: errMsg }
                );
              }
            }
          }
        }
      }
    } catch (err) {
      logger.error('[Meta] Error processing webhook event:', {
        error: err.message,
      });
    }
  });
});

module.exports = router;
