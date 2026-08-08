'use strict';

/**
 * server.js — Express application entry point.
 *
 * Middleware order matters:
 *  1. CORS
 *  2. Raw-body capture for /webhooks/* (MUST come before any JSON parser)
 *  3. JSON body parser for all other routes
 *  4. Request logger
 *  5. Route mounts
 *  6. Static frontend (when SERVE_FRONTEND=true)
 *  7. 404 / error handlers
 *  8. HTTP server start + abandoned-cart scheduler
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const logger = require('./logger');
const { startAbandonedCartScheduler } = require('./abandonedCart');
const {
  normalisePayload,
  handleAbandonedCart,
  handleOrderCreated,
} = require('./fastrr'); // used by the POST / fallback below

const app = express();
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

// ── CORS ──────────────────────────────────────────────────────────────────────
// In production set ALLOWED_ORIGINS=https://yourdomain.com,https://www.yourdomain.com
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
  : null; // null = allow all (safe for local dev)

app.use(
  cors({
    origin: allowedOrigins
      ? (origin, cb) => {
          // Allow requests with no origin (curl, Postman, Shopify webhooks)
          if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
          cb(new Error(`CORS: origin ${origin} not allowed`));
        }
      : '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

// ── Raw-body capture for Shopify webhook HMAC verification ────────────────────
// Must run before any body-parsing middleware for /webhooks/* paths.
app.use((req, res, next) => {
  if (!req.path.startsWith('/webhooks/')) return next();

  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    req.rawBody = Buffer.concat(chunks);
    try {
      req.body = JSON.parse(req.rawBody.toString('utf8'));
    } catch {
      req.body = {};
    }
    next();
  });
  req.on('error', (err) => {
    logger.error('Error reading webhook body:', { error: err.message });
    res.status(400).json({ error: 'Failed to read request body' });
  });
});

// ── JSON + URL-encoded body parsers for non-webhook routes ─────────────────────
app.use((req, res, next) => {
  if (req.path.startsWith('/webhooks/')) return next();
  const ct = req.headers['content-type'] || '';
  if (ct.includes('application/x-www-form-urlencoded')) {
    return express.urlencoded({ extended: true, limit: '1mb' })(req, res, next);
  }
  express.json({ limit: '1mb' })(req, res, next);
});

// ── Request logger ────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    logger.info(`${req.method} ${req.originalUrl} ${res.statusCode} — ${ms}ms`, {
      ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress,
    });
  });
  next();
});

// ── API + Webhook Routes ──────────────────────────────────────────────────────
// ⚠️  ORDER MATTERS: more-specific paths (/webhooks/fastrr, /webhooks/meta)
//    MUST be mounted BEFORE the generic /webhooks router, otherwise Express
//    matches the generic prefix first and the sub-routers are never reached.
app.use('/health',    require('./routes/health'));

// ── Fastrr Checkout (Shiprocket) ── REMOVE THIS LINE to disable Fastrr ───────
app.use('/webhooks/fastrr', require('./routes/fastrr'));

// ── Meta WhatsApp Cloud API ───────────────────────────────────────────────────
// Handles verification handshake (GET) + status updates/replies (POST)
app.use('/webhooks/meta',   require('./routes/meta'));

// ── Shopify webhooks (generic — must come AFTER the specific sub-paths above) ──
app.use('/webhooks',  require('./routes/webhooks'));
app.use('/api',       require('./routes/api'));

// ── Serve built React frontend ────────────────────────────────────────────────
// Set SERVE_FRONTEND=true in .env to have one Node process serve everything.
// Run `npm run build` inside /frontend first.
// Optional: set FRONTEND_DIST to an absolute path if your layout differs.
if (process.env.SERVE_FRONTEND === 'true') {
  const distPath = process.env.FRONTEND_DIST
    ? path.resolve(process.env.FRONTEND_DIST)
    : path.join(__dirname, '..', 'frontend', 'dist');

  app.use(express.static(distPath));

  // SPA fallback — any unmatched GET returns index.html
  app.get('*', (_req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });

  logger.info(`📦 Serving frontend from: ${distPath}`);
}

// ── Fastrr ROOT fallback ─────────────────────────────────────────────────────
// Catches ALL POST requests to "/" — Fastrr sends here when dashboard URL is wrong.
// Always returns 200 so Fastrr doesn't retry. Fix URL in Fastrr dashboard!
app.post('/', (req, res) => {
  const body   = req.body || {};
  const rawStr = JSON.stringify(body);

  logger.warn(
    '[Server] ⚠️  POST / received — treating as Fastrr webhook.' +
    ' Please fix webhook URL in Fastrr dashboard to /webhooks/fastrr',
    {
      ip:         req.headers['x-forwarded-for'] || req.socket?.remoteAddress,
      bodyKeys:   Object.keys(body),
      bodySnippet: rawStr.slice(0, 300),
    }
  );

  // Acknowledge immediately so Fastrr never retries
  res.status(200).json({ received: true });

  // Process async
  setImmediate(async () => {
    try {
      if (!Object.keys(body).length) {
        logger.error('[Root Fastrr fallback] Empty body — body parser may have failed.' +
          ' Content-Type was: ' + (req.headers['content-type'] || 'missing'));
        return;
      }
      const data  = normalisePayload(body);
      const event = data.event;
      logger.info(`[Root Fastrr fallback] Processing event: "${event}"`, {
        checkoutId: data.checkoutId,
        phone:      data.phone,
        items:      data.lineItems?.length,
      });
      if (event === 'order_created' || event === 'checkout_completed' || event === 'purchase') {
        await handleOrderCreated(data);
      } else {
        await handleAbandonedCart(data);
      }
    } catch (err) {
      logger.error('[Root Fastrr fallback] Error:', { error: err.message, stack: err.stack });
    }
  });
});

// ── Privacy Policy ────────────────────────────────────────────────────────────
app.get('/privacy-policy', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Privacy Policy – WhatsApp Automation</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      background: #f7f8fc;
      color: #1a1a2e;
      line-height: 1.75;
      padding: 2rem 1rem;
    }
    .container {
      max-width: 780px;
      margin: 0 auto;
      background: #ffffff;
      border-radius: 12px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.07);
      padding: 3rem 2.5rem;
    }
    h1 {
      font-size: 2rem;
      font-weight: 700;
      color: #0d1b2a;
      margin-bottom: 0.25rem;
    }
    .last-updated {
      font-size: 0.85rem;
      color: #6b7280;
      margin-bottom: 2rem;
    }
    h2 {
      font-size: 1.15rem;
      font-weight: 600;
      color: #0d1b2a;
      margin-top: 2rem;
      margin-bottom: 0.5rem;
      padding-bottom: 0.3rem;
      border-bottom: 2px solid #e5e7eb;
    }
    p, li { font-size: 0.97rem; color: #374151; }
    ul { padding-left: 1.4rem; margin-top: 0.4rem; }
    li { margin-bottom: 0.35rem; }
    a { color: #2563eb; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .highlight {
      background: #eff6ff;
      border-left: 4px solid #2563eb;
      padding: 0.75rem 1rem;
      border-radius: 6px;
      margin-top: 1rem;
      font-size: 0.95rem;
      color: #1e40af;
    }
    footer {
      margin-top: 3rem;
      font-size: 0.8rem;
      color: #9ca3af;
      text-align: center;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Privacy Policy</h1>
    <p class="last-updated">Last updated: August 8, 2025</p>

    <h2>1. Introduction</h2>
    <p>
      This Privacy Policy explains how <strong>WhatsApp Automation</strong> (&ldquo;we&rdquo;, &ldquo;our&rdquo;, or &ldquo;the Service&rdquo;)
      collects, uses, stores, and protects information when we send WhatsApp messages on behalf of
      our merchant partners using the Meta WhatsApp Business Cloud API. By using this Service, you
      agree to the practices described below.
    </p>

    <h2>2. Data We Collect</h2>
    <p>To deliver WhatsApp notifications, we collect and process the following information:</p>
    <ul>
      <li><strong>Phone numbers</strong> – provided by the merchant at checkout or sign-up, used solely to route messages to the correct recipient.</li>
      <li><strong>Message content</strong> – order confirmations, abandoned-cart reminders, shipping updates, and promotional messages generated from the merchant&rsquo;s Shopify store data.</li>
      <li><strong>Order &amp; cart data</strong> – order ID, items, amounts, and status received via Shopify webhooks; used only to personalise message content.</li>
      <li><strong>Delivery status</strong> – read receipts and delivery reports returned by the Meta Cloud API; used to track message success rates.</li>
    </ul>
    <p>We do <strong>not</strong> collect passwords, payment card details, or any sensitive financial information.</p>

    <h2>3. How We Use Your Data</h2>
    <ul>
      <li>Send order, shipping, and marketing WhatsApp messages on behalf of the merchant.</li>
      <li>Schedule and retry abandoned-cart notifications.</li>
      <li>Maintain service logs for debugging and quality assurance.</li>
      <li>Comply with legal obligations and Meta&rsquo;s WhatsApp Business Policy.</li>
    </ul>
    <p>We do <strong>not</strong> sell, rent, or share personal data with third parties for their own marketing purposes.</p>

    <h2>4. Data Storage &amp; Security</h2>
    <ul>
      <li>Data is processed and stored on servers hosted by <strong>Render</strong> (render.com), located in the United States.</li>
      <li>All data in transit is encrypted using <strong>TLS 1.2+</strong>.</li>
      <li>Server logs are retained for up to <strong>30 days</strong> and then automatically purged.</li>
      <li>Access to production systems is restricted to authorised personnel only and protected by SSH key authentication.</li>
      <li>API secrets and tokens are stored as environment variables — never hard-coded.</li>
    </ul>

    <h2>5. Third-Party Services</h2>
    <p>We integrate with the following third-party platforms, each with their own privacy policies:</p>
    <ul>
      <li><a href="https://www.whatsapp.com/legal/privacy-policy" target="_blank" rel="noopener noreferrer">Meta / WhatsApp Business Cloud API</a> – message delivery.</li>
      <li><a href="https://www.shopify.com/legal/privacy" target="_blank" rel="noopener noreferrer">Shopify</a> – order and customer data source.</li>
      <li><a href="https://render.com/privacy" target="_blank" rel="noopener noreferrer">Render</a> – cloud hosting provider.</li>
    </ul>

    <h2>6. Your Rights &amp; Data Deletion</h2>
    <p>You have the right to:</p>
    <ul>
      <li>Request access to the personal data we hold about you.</li>
      <li>Request correction of inaccurate data.</li>
      <li>Request deletion of your personal data from our systems.</li>
      <li>Opt out of marketing messages at any time by replying <strong>STOP</strong> to any WhatsApp message.</li>
    </ul>
    <div class="highlight">
      To exercise any of these rights or to request data deletion, please contact us at:<br />
      <strong>📧 <a href="mailto:whatsappforbussiness@gmail.com">whatsappforbussiness@gmail.com</a></strong><br />
      We will respond within <strong>10 business days</strong>.
    </div>

    <h2>7. Cookies &amp; Tracking</h2>
    <p>
      This service operates as a backend API and does not use cookies, browser tracking pixels, or
      analytics scripts. No data is collected from users browsing this URL.
    </p>

    <h2>8. Children&rsquo;s Privacy</h2>
    <p>
      This Service is not directed at children under 13. We do not knowingly collect personal
      information from children. If you believe we have inadvertently collected such information,
      please contact us immediately.
    </p>

    <h2>9. Changes to This Policy</h2>
    <p>
      We may update this Privacy Policy periodically. The &ldquo;Last updated&rdquo; date at the top of this page
      reflects the most recent revision. Continued use of the Service after any changes constitutes
      acceptance of the revised policy.
    </p>

    <h2>10. Contact Us</h2>
    <p>
      If you have any questions about this Privacy Policy, please reach out:<br />
      <strong>Email:</strong> <a href="mailto:whatsappforbussiness@gmail.com">whatsappforbussiness@gmail.com</a>
    </p>

    <footer>
      &copy; 2025 WhatsApp Automation. All rights reserved.
    </footer>
  </div>
</body>
</html>`);
});

// ── 404 handler (API routes only when SERVE_FRONTEND is off) ─────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Not found: ${req.method} ${req.path}` });
});

// ── Global error handler ──────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  logger.error('Unhandled error:', { error: err.message, path: req.path });
  res.status(500).json({ error: 'Internal server error' });
});

// ── Startup env check ─────────────────────────────────────────────────────────
function warnMissingEnv() {
  const required = [
    'WHATSAPP_TOKEN',
    'WHATSAPP_PHONE_NUMBER_ID',
    'SHOPIFY_WEBHOOK_SECRET',
    'META_VERIFY_TOKEN',
  ];
  const optional = [
    'SHOPIFY_SHOP',
    'SHOPIFY_CLIENT_ID',
    'SHOPIFY_CLIENT_SECRET',
    'FASTRR_WEBHOOK_SECRET',
  ];
  required.forEach((k) => {
    if (!process.env[k]) logger.warn(`⚠️  Missing required env var: ${k}`);
  });
  optional.forEach((k) => {
    if (!process.env[k]) logger.info(`ℹ️  Optional env var not set: ${k}`);
  });
}

// ── Start server ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  logger.info(`🚀 Server → http://localhost:${PORT}`);
  logger.info(`   Health   → http://localhost:${PORT}/health`);
  logger.info(`   API      → http://localhost:${PORT}/api/stats`);
  logger.info(`   Meta WH  → http://localhost:${PORT}/webhooks/meta`);
  logger.info(`   Fastrr   → http://localhost:${PORT}/webhooks/fastrr/test`);
  logger.info(`   Mode     → ${IS_PROD ? 'production' : 'development'}`);
  warnMissingEnv();
  startAbandonedCartScheduler();
});

module.exports = app; // exported for testing
