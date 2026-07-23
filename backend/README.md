# ShopChat — Backend (Node.js / Express)

Connects **Shopify** to **WhatsApp Business Cloud API** for automated order confirmations and abandoned-cart reminders.

---

## Quick Start

### 1. Install dependencies

```bash
cd backend
npm install
```

### 2. Configure environment variables

```bash
cp .env.example .env
```

Edit `.env` and fill in your credentials (see details below).

### 3. Start the server

```bash
npm start          # production
npm run dev        # development (auto-reload with nodemon)
```

The server starts at `http://localhost:3000` (or your `PORT`).

---

## Environment Variables

| Variable | Description |
|---|---|
| `WHATSAPP_TOKEN` | Permanent access token from Meta (WhatsApp Business Cloud) |
| `WHATSAPP_PHONE_NUMBER_ID` | Phone Number ID from Meta's WhatsApp API Setup |
| `SHOPIFY_WEBHOOK_SECRET` | Secret shown when creating a Shopify webhook |
| `PORT` | HTTP port (default `3000`) |
| `DEFAULT_COUNTRY_CODE` | Used when normalizing 10-digit local numbers (default `1` for US) |

---

## Getting Credentials

### WhatsApp (Meta Cloud API)

1. Go to [developers.facebook.com](https://developers.facebook.com)
2. Create a new app → **Business** type
3. Add the **WhatsApp** product
4. Under **WhatsApp → API Setup**, find:
   - **Phone Number ID** → `WHATSAPP_PHONE_NUMBER_ID`
   - **Temporary access token** (generate a permanent one via System Users for production) → `WHATSAPP_TOKEN`

### Shopify Webhook Secret

1. Log into your Shopify admin
2. **Settings → Notifications → Webhooks**
3. Create a webhook (e.g. `orders/create`) pointing at your public URL
4. The **Signing secret** shown at the bottom → `SHOPIFY_WEBHOOK_SECRET`

---

## Webhooks to Register in Shopify

| Shopify Event | This Server Endpoint |
|---|---|
| `orders/create` | `POST /webhooks/orders-create` |
| `checkouts/create` | `POST /webhooks/checkouts-create` |
| `checkouts/update` | `POST /webhooks/checkouts-update` |

### Local Testing with ngrok

```bash
# Install ngrok: https://ngrok.com/download
ngrok http 3000
```

Use the generated `https://xxxx.ngrok.io` URL as your Shopify webhook base URL.

Example:
```
https://xxxx.ngrok.io/webhooks/orders-create
```

---

## API Endpoints (for the frontend dashboard)

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check |
| `GET` | `/api/stats` | Dashboard summary stats |
| `GET` | `/api/orders` | Paginated order list |
| `POST` | `/api/orders/:id/resend` | Resend WhatsApp for an order |
| `GET` | `/api/abandoned-carts` | All tracked checkouts |
| `POST` | `/api/abandoned-carts/:id/remind` | Manually trigger cart reminder |
| `GET` | `/api/messages` | Message log (filterable) |
| `GET` | `/api/settings` | Current settings (secrets masked) |
| `POST` | `/api/settings` | Update settings |
| `POST` | `/api/settings/test-whatsapp` | Verify WhatsApp credentials |

---

## Project Structure

```
backend/
├── server.js          # Express entry point
├── whatsapp.js        # WhatsApp Cloud API helper
├── shopifyAuth.js     # HMAC webhook verification
├── abandonedCart.js   # Cron-based abandoned cart scheduler
├── store.js           # In-memory + JSON data store
├── logger.js          # Winston logger
├── routes/
│   ├── api.js         # Dashboard REST API
│   ├── webhooks.js    # Shopify webhook handlers
│   └── health.js      # Health check
├── data/              # store.json written here (git-ignored)
├── logs/              # app.log / error.log (git-ignored)
└── .env               # Your secrets (never commit this)
```

---

## Abandoned Cart Logic

- Shopify checkout data is stored in memory and persisted to `data/store.json`
- A `node-cron` job runs **every 5 minutes**
- Any checkout older than **1 hour** with no matching order and no prior reminder triggers a WhatsApp message
- Once reminded (or if the customer completed the order), the checkout is marked so no duplicate messages are sent
