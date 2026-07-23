# ShopChat — Frontend (React / Vite)

A beautiful dashboard to monitor and manage your Shopify × WhatsApp automation.

---

## Quick Start

### 1. Install dependencies

```bash
cd frontend
npm install
```

### 2. Configure the API URL

```bash
cp .env.example .env
```

Edit `.env`:

```env
VITE_API_BASE_URL=http://localhost:3000
```

> For production, replace `http://localhost:3000` with your deployed backend URL.

### 3. Start the dev server

```bash
npm run dev
```

Opens at `http://localhost:5173`

---

## Pages

| Page | Route | Description |
|---|---|---|
| Dashboard | `/dashboard` | Stat cards + 7-day message chart |
| Orders | `/orders` | Order table with Resend button |
| Abandoned Carts | `/abandoned-carts` | Cart table with manual reminder |
| Message Logs | `/message-logs` | Full message log with filters |
| Settings | `/settings` | Credential configuration + test |

---

## Project Structure

```
frontend/
├── src/
│   ├── App.jsx                  # Router + layout
│   ├── main.jsx                 # React entry point
│   ├── index.css                # Tailwind + global styles
│   ├── api/
│   │   ├── client.js            # Axios instance (reads VITE_API_BASE_URL)
│   │   └── endpoints.js         # All API call functions
│   ├── components/
│   │   ├── Sidebar.jsx          # Dark sidebar navigation
│   │   ├── StatCard.jsx         # Summary metric card
│   │   ├── DataTable.jsx        # Reusable table with skeleton loading
│   │   └── StatusBadge.jsx      # Colour-coded status pill
│   └── pages/
│       ├── Dashboard.jsx
│       ├── Orders.jsx
│       ├── AbandonedCarts.jsx
│       ├── MessageLogs.jsx
│       └── Settings.jsx
├── index.html
├── vite.config.js
├── tailwind.config.js
└── postcss.config.js
```

---

## Tech Stack

| Library | Purpose |
|---|---|
| React 18 | UI framework |
| Vite 5 | Build tool + dev server |
| Tailwind CSS 3 | Utility-first styling |
| React Router 6 | Client-side routing |
| Axios | HTTP client |
| Recharts | Area chart on Dashboard |
| Lucide React | Icon library |
| react-hot-toast | Toast notifications |

---

## Production Build

```bash
npm run build
```

Output goes to `dist/`. Serve it with any static file host or CDN.

---

## Design

- **Color scheme**: WhatsApp green (#25D366) accent on a dark slate sidebar + white card layout
- **Typography**: Inter (from Google Fonts)
- **Animations**: CSS keyframe fade-in / slide-up on page transitions
- **Loading**: Skeleton shimmer rows on all tables and cards
- **Errors**: Dark toast notifications (top-right)
