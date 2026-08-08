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

// ── Terms of Service ──────────────────────────────────────────────────────────
app.get('/terms-of-service', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Terms of Service – WhatsApp Automation</title>
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
    h1 { font-size: 2rem; font-weight: 700; color: #0d1b2a; margin-bottom: 0.25rem; }
    .last-updated { font-size: 0.85rem; color: #6b7280; margin-bottom: 2rem; }
    h2 {
      font-size: 1.15rem; font-weight: 600; color: #0d1b2a;
      margin-top: 2rem; margin-bottom: 0.5rem;
      padding-bottom: 0.3rem; border-bottom: 2px solid #e5e7eb;
    }
    p, li { font-size: 0.97rem; color: #374151; }
    ul { padding-left: 1.4rem; margin-top: 0.4rem; }
    li { margin-bottom: 0.35rem; }
    a { color: #2563eb; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .highlight {
      background: #f0fdf4; border-left: 4px solid #16a34a;
      padding: 0.75rem 1rem; border-radius: 6px;
      margin-top: 1rem; font-size: 0.95rem; color: #15803d;
    }
    footer { margin-top: 3rem; font-size: 0.8rem; color: #9ca3af; text-align: center; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Terms of Service</h1>
    <p class="last-updated">Last updated: August 8, 2025</p>

    <h2>1. Acceptance of Terms</h2>
    <p>
      By accessing or using the <strong>WhatsApp Automation</strong> service (&ldquo;Service&rdquo;),
      you agree to be bound by these Terms of Service (&ldquo;Terms&rdquo;). If you do not agree, please
      discontinue use of the Service immediately.
    </p>

    <h2>2. Description of Service</h2>
    <p>
      WhatsApp Automation enables merchant partners to send automated WhatsApp messages
      (order confirmations, shipping updates, abandoned-cart reminders, and promotional notifications)
      to their customers via the Meta WhatsApp Business Cloud API, integrated with Shopify stores.
    </p>

    <h2>3. Eligibility</h2>
    <ul>
      <li>You must be at least 18 years old to use this Service.</li>
      <li>You must have a valid Shopify store and an approved Meta WhatsApp Business account.</li>
      <li>Use of the Service for illegal, fraudulent, or abusive purposes is strictly prohibited.</li>
    </ul>

    <h2>4. Merchant Responsibilities</h2>
    <ul>
      <li>You are solely responsible for obtaining valid opt-in consent from your customers before sending them WhatsApp messages.</li>
      <li>You must comply with Meta&rsquo;s <a href="https://www.whatsapp.com/legal/business-policy" target="_blank" rel="noopener noreferrer">WhatsApp Business Policy</a> and all applicable laws (including GDPR, TCPA, and TRAI regulations).</li>
      <li>You must not use the Service to send spam, unsolicited messages, or content that violates Meta&rsquo;s policies.</li>
      <li>You are responsible for the accuracy of all message content, product information, and customer data sent through the Service.</li>
    </ul>

    <h2>5. Prohibited Uses</h2>
    <p>You agree NOT to use the Service to:</p>
    <ul>
      <li>Send messages without explicit customer opt-in consent.</li>
      <li>Distribute illegal, harmful, defamatory, or fraudulent content.</li>
      <li>Reverse-engineer, scrape, or attempt to access the Service&rsquo;s infrastructure without authorisation.</li>
      <li>Resell or sublicense the Service to third parties without prior written consent.</li>
    </ul>

    <h2>6. Intellectual Property</h2>
    <p>
      All software, code, designs, and content comprising the Service are the intellectual property of
      WhatsApp Automation and its licensors. You are granted a limited, non-exclusive, non-transferable
      licence to use the Service solely for your business purposes.
    </p>

    <h2>7. Limitation of Liability</h2>
    <p>
      To the fullest extent permitted by law, WhatsApp Automation shall not be liable for any indirect,
      incidental, special, or consequential damages arising from your use of the Service, including but
      not limited to loss of revenue, data, or business opportunities. Our total liability shall not
      exceed the fees paid by you in the 30 days preceding the claim.
    </p>

    <h2>8. Disclaimer of Warranties</h2>
    <p>
      The Service is provided &ldquo;as is&rdquo; without warranties of any kind, express or implied.
      We do not guarantee uninterrupted service, error-free operation, or that messages will always
      be delivered (delivery depends on Meta&rsquo;s infrastructure and the recipient&rsquo;s network).
    </p>

    <h2>9. Termination</h2>
    <p>
      We reserve the right to suspend or terminate your access to the Service at any time, with or
      without notice, if you violate these Terms or Meta&rsquo;s policies. Upon termination, your data
      will be handled as described in our <a href="/privacy-policy">Privacy Policy</a>.
    </p>

    <h2>10. Governing Law</h2>
    <p>
      These Terms are governed by the laws of India. Any disputes shall be subject to the exclusive
      jurisdiction of the courts located in India.
    </p>

    <h2>11. Changes to These Terms</h2>
    <p>
      We may update these Terms periodically. The &ldquo;Last updated&rdquo; date reflects the most recent
      revision. Continued use of the Service after changes constitutes acceptance of the revised Terms.
    </p>

    <h2>12. Contact Us</h2>
    <div class="highlight">
      For questions about these Terms, please contact:<br />
      <strong>📧 <a href="mailto:whatsappforbussiness@gmail.com">whatsappforbussiness@gmail.com</a></strong>
    </div>

    <footer>&copy; 2025 WhatsApp Automation. All rights reserved.</footer>
  </div>
</body>
</html>`);
});

// ── Data Deletion ─────────────────────────────────────────────────────────────
app.get('/data-deletion', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Data Deletion Request – WhatsApp Automation</title>
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
      max-width: 680px;
      margin: 0 auto;
      background: #ffffff;
      border-radius: 12px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.07);
      padding: 3rem 2.5rem;
    }
    .icon { font-size: 3rem; text-align: center; margin-bottom: 1rem; }
    h1 { font-size: 1.9rem; font-weight: 700; color: #0d1b2a; margin-bottom: 0.25rem; text-align: center; }
    .subtitle { font-size: 0.95rem; color: #6b7280; margin-bottom: 2rem; text-align: center; }
    h2 {
      font-size: 1.1rem; font-weight: 600; color: #0d1b2a;
      margin-top: 2rem; margin-bottom: 0.5rem;
      padding-bottom: 0.3rem; border-bottom: 2px solid #e5e7eb;
    }
    p, li { font-size: 0.97rem; color: #374151; }
    ul { padding-left: 1.4rem; margin-top: 0.4rem; }
    li { margin-bottom: 0.35rem; }
    a { color: #2563eb; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .card {
      background: #fff7ed; border: 1px solid #fed7aa;
      border-radius: 10px; padding: 1.5rem 1.75rem; margin-top: 1.5rem;
    }
    .card h3 { font-size: 1rem; font-weight: 600; color: #9a3412; margin-bottom: 0.5rem; }
    .email-btn {
      display: inline-block;
      margin-top: 1rem;
      background: #ea580c;
      color: #ffffff;
      padding: 0.65rem 1.5rem;
      border-radius: 8px;
      font-weight: 600;
      font-size: 0.95rem;
      text-decoration: none;
      transition: background 0.2s;
    }
    .email-btn:hover { background: #c2410c; text-decoration: none; }
    .steps {
      counter-reset: step-counter;
      list-style: none;
      padding: 0;
      margin-top: 0.75rem;
    }
    .steps li {
      counter-increment: step-counter;
      padding: 0.5rem 0 0.5rem 2.5rem;
      position: relative;
    }
    .steps li::before {
      content: counter(step-counter);
      position: absolute; left: 0; top: 0.45rem;
      background: #0d1b2a; color: #fff;
      font-size: 0.75rem; font-weight: 700;
      width: 1.5rem; height: 1.5rem;
      border-radius: 50%; display: flex;
      align-items: center; justify-content: center;
    }
    .badge {
      display: inline-block; background: #dcfce7; color: #166534;
      font-size: 0.78rem; font-weight: 600; padding: 0.2rem 0.6rem;
      border-radius: 999px; margin-left: 0.4rem; vertical-align: middle;
    }
    footer { margin-top: 3rem; font-size: 0.8rem; color: #9ca3af; text-align: center; }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">🗑️</div>
    <h1>Data Deletion Request</h1>
    <p class="subtitle">Your privacy matters. We will delete your data promptly upon request.</p>

    <h2>What Data We Hold</h2>
    <p>When you interact with a merchant using our WhatsApp Automation service, we may hold:</p>
    <ul>
      <li>Your <strong>phone number</strong> used to send WhatsApp messages.</li>
      <li><strong>Message content</strong> (order updates, cart reminders) generated from Shopify order data.</li>
      <li><strong>Delivery status</strong> (read/delivered receipts from Meta&rsquo;s API).</li>
      <li>Server <strong>log entries</strong> referencing your phone number (retained for up to 30 days).</li>
    </ul>

    <h2>How to Request Deletion</h2>
    <p>To request that your personal data be deleted from our systems, follow these steps:</p>
    <ol class="steps">
      <li>Send an email to the address below with the subject line: <strong>&ldquo;Data Deletion Request&rdquo;</strong>.</li>
      <li>Include your <strong>phone number</strong> (in international format, e.g. +91XXXXXXXXXX) so we can locate your records.</li>
      <li>We will confirm receipt within <strong>2 business days</strong> and complete the deletion within <strong>10 business days</strong>.</li>
      <li>You will receive a confirmation email once your data has been permanently deleted. <span class="badge">✓ Confirmed</span></li>
    </ol>

    <div class="card">
      <h3>📧 Send Your Deletion Request To:</h3>
      <p>
        <strong>Email:</strong>
        <a href="mailto:whatsappforbussiness@gmail.com">whatsappforbussiness@gmail.com</a>
      </p>
      <p style="margin-top:0.4rem; font-size:0.9rem; color:#7c3a10;">
        Please use subject: <em>"Data Deletion Request"</em> and include your phone number.
      </p>
      <a class="email-btn" href="mailto:whatsappforbussiness@gmail.com?subject=Data%20Deletion%20Request&body=Hello%2C%0A%0AI%20would%20like%20to%20request%20deletion%20of%20my%20personal%20data.%0A%0AMy%20phone%20number%3A%20%2B91XXXXXXXXXX%0A%0AThank%20you.">
        ✉️ Email Us Now
      </a>
    </div>

    <h2>What Happens After Deletion</h2>
    <ul>
      <li>Your phone number and associated message history will be permanently removed from our active systems.</li>
      <li>Automated log files referencing your data will be purged on their standard 30-day cycle (or sooner upon request).</li>
      <li>Note: We cannot delete data that has already been transmitted to and stored by Meta&rsquo;s WhatsApp servers. Please refer to <a href="https://www.whatsapp.com/legal/privacy-policy" target="_blank" rel="noopener noreferrer">WhatsApp&rsquo;s Privacy Policy</a> for their data practices.</li>
    </ul>

    <h2>Opt Out of Messages</h2>
    <p>
      You can stop receiving WhatsApp messages at any time by replying <strong>STOP</strong> to any message
      you receive. This will immediately remove you from future message sends.
    </p>

    <p style="margin-top:1.5rem;">
      For more information, see our <a href="/privacy-policy">Privacy Policy</a> and
      <a href="/terms-of-service">Terms of Service</a>.
    </p>

    <footer>&copy; 2025 WhatsApp Automation. All rights reserved.</footer>
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
