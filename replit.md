# Predara — Prediction Market Analyzer

## Overview
Node.js web app that analyzes Kalshi and Polymarket prediction markets. Users paste a market URL and get a full breakdown of odds, volume, liquidity, and market structure.

## Architecture
- **server.js** — HTTP server on port 5000 / 0.0.0.0. Proxies API calls to Kalshi (authenticated via RSA-signed JWT) and Polymarket (public gamma API). Serves static files.
- **app.js** — Client-side rendering. Detects platform from URL, fetches data via `/api/kalshi` or `/api/polymarket`, renders event header, outcomes, stats, timeline, and rules.
- **index.html** — Single-page app shell with all CSS inline.
- **api/kalshi.js**, **api/polymarket.js** — Vercel serverless functions for predara.org production. **DO NOT MODIFY** these files.

## Key Data Points Displayed
- **Kalshi**: Bid/ask spread per outcome, per-outcome volume & OI (multi-outcome), resolution criteria, mutually exclusive badge, early close condition text, price delta vs previous close, moneyline odds
- **Polymarket**: Topic tags, comment count, bid/ask spread, volume, liquidity, timeline

## Important Conventions
- `volume_fp` and `open_interest_fp` are in **cents** (divide by 100 for dollars)
- `volume_24h_fp` is cents; `volume_24h` is already dollars — prefer `_fp/100`, fall back to raw
- Multi-outcome detection: `markets.length > 2`
- PEM key normalization in server.js handles any secret storage format
- Outcome rows are paginated 10-at-a-time via `buildOutcomesHtml`/`window._outcomePages`

## Secrets
- `KALSHI_API_KEY_ID` — Kalshi API key member ID
- `KALSHI_PRIVATE_KEY` — RSA private key for JWT signing

## Deployment
- Replit: `node server.js` on port 5000 (autoscale deployment configured)
- Vercel: Uses `api/` serverless functions (separate deployment, do not modify)
