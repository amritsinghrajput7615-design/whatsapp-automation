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

// ── JSON body parser for non-webhook routes ───────────────────────────────────
app.use((req, res, next) => {
  if (req.path.startsWith('/webhooks/')) return next();
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
app.use('/health',    require('./routes/health'));
app.use('/webhooks',  require('./routes/webhooks'));
app.use('/api',       require('./routes/api'));

// ── Fastrr Checkout (Shiprocket) ── REMOVE THIS LINE to disable Fastrr ───────
app.use('/webhooks/fastrr', require('./routes/fastrr'));

// ── Meta WhatsApp Cloud API ───────────────────────────────────────────────────
// Handles verification handshake (GET) + status updates/replies (POST)
app.use('/webhooks/meta',   require('./routes/meta'));

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

// ── Start server ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  logger.info(`🚀 Server → http://localhost:${PORT}`);
  logger.info(`   Health   → http://localhost:${PORT}/health`);
  logger.info(`   API      → http://localhost:${PORT}/api/stats`);
  logger.info(`   Meta WH  → http://localhost:${PORT}/webhooks/meta`);
  logger.info(`   Fastrr   → http://localhost:${PORT}/webhooks/fastrr/test`);
  logger.info(`   Mode     → ${IS_PROD ? 'production' : 'development'}`);

  startAbandonedCartScheduler();
});

module.exports = app; // exported for testing
