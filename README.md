# Predara

**Predara turns prediction market listings into plain-English betting decisions.**

Paste a market URL from Kalshi, Polymarket, Coinbase, or Gemini and Predara tells you exactly what you're betting on, how it resolves, and whether the odds are worth it — no contract jargon, no digging through fine print.

🔗 [predara.org](https://predara.org)

## Why it exists

Prediction markets bury the information traders actually need — resolution criteria, true breakeven odds, expected value — inside legalese and scattered API fields. Predara's job is to close that gap: take a raw market and surface a clear, beginner-friendly breakdown that a first-time trader and a seasoned one can both use to decide whether to bet.

## What it does

- **"What's the bet?"** — a one-line, plain-English summary of the wager, generated from the market's own rules text
- **Bet calculator** — enter a dollar amount and see exactly what you win or lose
- **How it resolves** — contract language rewritten in plain English, with legal boilerplate stripped out
- **Trader analytics** — expected value, Kelly criterion, breakeven odds, and spread quality, computed per outcome
- **Market context** — volume, liquidity, open interest, bid/ask spread, and a close-date urgency indicator
- **Glossary tooltips** — hover any stat to see what it means, no prior market experience required

## Supported platforms

| Platform | Routing |
|---|---|
| Kalshi | Direct API (RSA-signed JWT) |
| Polymarket | Public Gamma API |
| Gemini | Direct public Prediction Markets API (`api.gemini.com/v1/prediction-markets`) |
| Coinbase | Routed through Polymarket or Kalshi, depending on market type |

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
app.js          Client-side rendering and market detection
components.js   Reusable UI building blocks
features.js     Feature-specific rendering (analytics, timeline, glossary)
adapters.js     Per-platform data normalization
compare.js      Market comparison logic
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
