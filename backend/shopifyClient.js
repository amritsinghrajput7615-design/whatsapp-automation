'use strict';

/**
 * shopifyClient.js — Shopify Admin API client using Client Credentials OAuth.
 *
 * How it works (from Shopify Dev Dashboard docs):
 *  1. Exchange SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET for an access token
 *     via POST /admin/oauth/access_token (grant_type: client_credentials)
 *  2. Cache the token in memory; re-fetch automatically 60 s before expiry
 *  3. Attach the token as X-Shopify-Access-Token on every GraphQL / REST call
 *
 * Required env vars:
 *   SHOPIFY_SHOP         — store subdomain only, e.g. "my-store" (not the full URL)
 *   SHOPIFY_CLIENT_ID    — from Shopify Dev Dashboard > Settings > Credentials
 *   SHOPIFY_CLIENT_SECRET — from Shopify Dev Dashboard > Settings > Credentials
 *
 * Exports:
 *   graphql(query, variables?)  → Promise<data>
 *   restGet(path)               → Promise<body>
 *   isConfigured()              → boolean
 */

const { URLSearchParams } = require('node:url');
const logger = require('./logger');

const API_VERSION = '2025-01';

// ── Token cache ───────────────────────────────────────────────────────────────

let _token = null;
let _tokenExpiresAt = 0; // epoch ms

/**
 * Return a valid access token, fetching a new one when needed.
 * Throws if env vars are missing.
 */
async function getToken() {
  // Return cached token if still valid (with 60 s safety buffer)
  if (_token && Date.now() < _tokenExpiresAt - 60_000) {
    return _token;
  }

  const { SHOPIFY_SHOP, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET } = process.env;

  if (!SHOPIFY_SHOP || !SHOPIFY_CLIENT_ID || !SHOPIFY_CLIENT_SECRET) {
    throw new Error(
      'Shopify client not configured — set SHOPIFY_SHOP, SHOPIFY_CLIENT_ID, and SHOPIFY_CLIENT_SECRET in .env'
    );
  }

  const url = `https://${SHOPIFY_SHOP}.myshopify.com/admin/oauth/access_token`;

  logger.info('Fetching new Shopify access token…');

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: SHOPIFY_CLIENT_ID,
      client_secret: SHOPIFY_CLIENT_SECRET,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `Shopify token request failed: HTTP ${response.status} — ${body}`
    );
  }

  const { access_token, expires_in } = await response.json();

  _token = access_token;
  // expires_in is in seconds; store expiry as epoch ms
  _tokenExpiresAt = Date.now() + (expires_in ?? 86400) * 1000;

  logger.info(`Shopify token acquired (expires in ${expires_in ?? 86400}s)`);
  return _token;
}

// ── GraphQL helper ────────────────────────────────────────────────────────────

/**
 * Execute a Shopify Admin GraphQL query / mutation.
 *
 * @param {string} query       GraphQL document
 * @param {object} [variables] GraphQL variables
 * @returns {Promise<object>}  Parsed `data` object from the response
 */
async function graphql(query, variables = {}) {
  const shop = process.env.SHOPIFY_SHOP;
  const url = `https://${shop}.myshopify.com/admin/api/${API_VERSION}/graphql.json`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': await getToken(),
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(`Shopify GraphQL request failed: HTTP ${response.status}`);
  }

  const { data, errors } = await response.json();

  if (errors?.length) {
    throw new Error(`Shopify GraphQL errors: ${JSON.stringify(errors)}`);
  }

  return data;
}

// ── REST helper ───────────────────────────────────────────────────────────────

/**
 * Simple GET wrapper for the Shopify Admin REST API.
 *
 * @param {string} path  e.g. '/orders.json?limit=10'
 * @returns {Promise<object>}
 */
async function restGet(path) {
  const shop = process.env.SHOPIFY_SHOP;
  const url = `https://${shop}.myshopify.com/admin/api/${API_VERSION}${path}`;

  const response = await fetch(url, {
    headers: {
      'X-Shopify-Access-Token': await getToken(),
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Shopify REST request failed: HTTP ${response.status}`);
  }

  return response.json();
}

// ── Utility ───────────────────────────────────────────────────────────────────

/**
 * Returns true if all three required env vars are present.
 * Use this to skip Shopify API calls when the store isn't configured yet.
 */
function isConfigured() {
  return !!(
    process.env.SHOPIFY_SHOP &&
    process.env.SHOPIFY_CLIENT_ID &&
    process.env.SHOPIFY_CLIENT_SECRET
  );
}

/** Expose the cached token state for diagnostics */
function tokenStatus() {
  if (!_token) return { cached: false };
  const expiresInMs = _tokenExpiresAt - Date.now();
  return {
    cached: true,
    expiresInSeconds: Math.max(0, Math.floor(expiresInMs / 1000)),
    expired: expiresInMs <= 0,
  };
}

module.exports = { graphql, restGet, getToken, isConfigured, tokenStatus };
