# Predara

**Predara turns prediction market listings into plain-English betting decisions.**

Paste a market URL from Kalshi, Polymarket, Coinbase, or Gemini and Predara tells you exactly what you're betting on, how it resolves, and whether the odds are worth it — no contract jargon, no digging through fine print.

🔗 [predara.org](https://predara.org)

## Why it exists

Prediction markets bury the information traders actually need — resolution criteria, true breakeven odds, expected value — inside legalese and scattered API fields. Predara's job is to close that gap: take a raw market and surface a clear, beginner-friendly breakdown that a first-time trader and a seasoned one can both use to decide whether to bet.

## What it does

- **"What's the bet?"** — a one-line, plain-English summary of the wager, generated from the market's own rules text
- **Bet calculator** — enter a dollar amount and see exactly what you win or lose, net of fees and the spread you cross
- **How it resolves** — contract language rewritten in plain English, with legal boilerplate stripped out
- **Trader analytics** — breakeven odds and spread quality per outcome; expected value and Kelly sizing appear once you state your own probability, because both are only defined against your estimate, not against the market's own price
- **Real fees** — the calculator prices off the ask you would actually hit (and `1 − bid` on the NO side), and applies each venue's published fee formula on entry, win or lose. Where a venue publishes no formula, Predara says so rather than inventing a rate
- **Market context** — volume, liquidity, open interest, bid/ask spread, and a close-date urgency indicator
- **Price history** — the platform's own time series (Kalshi candlesticks, Polymarket CLOB), over 24h / 1w / 1m
- **Price alerts** — checked every 3 minutes across every alerted market for as long as Predara is open in a tab, with optional relay to Discord, Slack or Telegram
- **Glossary tooltips** — hover any stat to see what it means, no prior market experience required
- **Prediction Markets Monitor** — platform-wide book quality for Gemini: quote coverage, average spread, event overround and dutch books, 24h volume, a per-category health matrix, and a volume heat map. Computed from the public event feed only; order-book depth is not available there and is reported as absent rather than estimated

## Supported platforms

| Platform | Routing |
|---|---|
| Kalshi | Direct API (RSA-signed JWT) |
| Polymarket | Public Gamma API |
| Gemini | Direct public Prediction Markets API (`api.gemini.com/v1/prediction-markets`) |
| Coinbase | Routed through Polymarket or Kalshi, depending on market type |

## Prediction Markets Monitor

The Monitor tab audits the health of Gemini's prediction-market book rather than
one market: how much of it is quoted, how wide, where the margin sits, and which
categories need attention. Every figure comes from the public API, and each one
prints its own denominator — the average spread says how many two-sided books it
covers, the overround says how many events were eligible. Metrics the public
feed cannot support (order-book depth and everything derived from it) are shown
as absent rather than estimated. See [ARCHITECTURE.md](ARCHITECTURE.md) for the
metric definitions.

## Settlement Desk

After a market closes, the Settlement Desk audits how it resolved. Most settlements are confirmed straight from the platform's own API with no AI call — those work out of the box.

When the API data has no clear winner, the case goes to Claude for analysis, and that requires **your own Anthropic API key**, entered in the "Your Anthropic API key" panel on the page. Predara runs no Anthropic key of its own, so AI analysis is always billed to your account, never ours. The key is stored only in your browser (no account needed) and is never logged or saved server-side.

## Getting started

```bash
npm install
npm start
```

The server runs on port 5000. Paste any supported market URL into the app to see a full breakdown.

## Tech stack

Plain JavaScript, no framework — a single-page client (`app.js`, `index.html`) backed by a lightweight Node HTTP server (`server.js`) that proxies and normalizes data from each platform's API. Production runs on Vercel via serverless functions in `api/`; `server.js` is the local development server. Both entrypoints share the same platform logic from `lib/`.

## Project structure

```
server.js       Local dev server — routes /api/* to the same lib/ code as production
api/            Vercel serverless functions (production — predara.org)
lib/            Shared platform logic imported by both api/ and server.js
lib/guard.js    Origin allowlist, response cache and rate limiting for /api/*
lib/history.js  Real price-history fetching (Kalshi candlesticks, Polymarket CLOB)
lib/notify.js   Webhook relay with a pinned destination allowlist
lib/monitor.js  Platform-wide book-quality metrics for the Monitor page
app.js          Client-side rendering and market detection
components.js   Reusable UI building blocks
features.js     Feature-specific rendering (analytics, timeline, glossary)
adapters.js     Per-platform data normalization
compare.js      Market comparison logic
monitor.html    Prediction Markets Monitor page shell
monitor.js      Monitor rendering — rollups, heat map, charts, tables
utils.js        Shared helpers
tests/          Test suite (node --test)
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for detailed architecture notes and conventions for contributors.

## Testing

```bash
npm test
```

## License

Proprietary — all rights reserved.
