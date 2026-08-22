# Predara — Prediction Market Analyzer

## Overview
Node.js web app that analyzes Kalshi, Polymarket, Gemini, and Coinbase prediction markets. Users paste a market URL and get a full breakdown of what they're betting on, resolution rules in plain English, a bet calculator, odds, volume, liquidity, and trader analytics. Gemini URLs route through Gemini's own public Prediction Markets REST API (`api.gemini.com/v1/prediction-markets`). Coinbase has two product surfaces: `predict.coinbase.com/markets/<slug>` (lowercase slugs) routes through the Polymarket gamma API, while `www.coinbase.com/predictions/event/<TICKER>` (uppercase tickers) routes through the Kalshi API.

## Architecture
- **lib/** — Shared platform logic, imported by both `api/` and `server.js` so the two entrypoints cannot drift. `lib/gemini.js` is the single source of truth for the Gemini Prediction Markets API; `lib/serverless.js` is the CORS/JSON shell for the read-only Vercel functions.
- **server.js** — Local dev HTTP server on port 5000 / 0.0.0.0. Proxies API calls to Kalshi (authenticated via RSA-signed JWT), Polymarket (public gamma API) and Gemini (public, unauthenticated). Serves static files.
- **app.js** — Client-side rendering. Detects platform from URL, fetches data via `/api/kalshi` or `/api/polymarket`, renders: "WHAT'S THE BET?" explainer, outcomes, bet simulator, resolution rules, timeline, trader analytics, glossary tooltips, and volume stats.
- **index.html** — Single-page app shell with all CSS inline.
- **api/*.js** — Vercel serverless functions for predara.org production. Keep these as thin HTTP shells: put the logic in `lib/` so `server.js` runs the same code path locally. `api/kalshi.js` and `api/polymarket.js` have not been migrated to `lib/` yet — change them only with care, since production deploys directly from this directory.

## Page Layout Order (beginner-first)
1. Event title + urgency banner
2. "WHAT'S THE BET?" card — plain-English explanation of what you're betting on
3. Outcomes & probability
4. Bet calculator — interactive "$X bet → win $Y / lose $X" simulator
5. "HOW IT RESOLVES" — resolution rules in plain English (contract jargon removed)
6. Timeline
7. Trader Analytics (EV, Kelly, Break-even, Spread)
8. Volume/Liquidity stats

## Key Features
- **"WHAT'S THE BET?" card**: Derives a plain-English summary from rules_primary (Kalshi) or market.description (Polymarket). Binary markets get "You win if..." / "You lose if...". Multi-outcome markets get "Pick which outcome you think will happen."
- **Bet Calculator**: `betSimulatorHtml(pct)` renders an interactive input. `updateBetSim()` recalculates in real-time via `window._betSimPct`.
- **Plain English Rules**: `plainEnglishRules(text)` rewrites contract language — "the market resolves to Yes" → "you win", strips boilerplate, removes legal disclaimers.
- **Polymarket Resolution Data**: Extracts `market.description`, `market.question`, and `market.resolutionSource` from individual markets (previously unused).
- **Kalshi**: Bid/ask spread per outcome, per-outcome volume & OI (multi-outcome), resolution criteria, mutually exclusive badge, early close condition text, price delta vs previous close, moneyline odds
- **Polymarket**: Topic tags, comment count, bid/ask spread, volume, liquidity, resolution source link
- **Trader Analytics** (both platforms): Break-even %, Expected Value %, Kelly Criterion %, Spread Quality %
- **Urgency Banner**: Time remaining until market close, color-coded (muted >7d, amber 1-7d, red <24h)
- **Glossary Tooltips**: Hover any stat label to see a plain-English definition

## Important Conventions
- `volume_fp` and `open_interest_fp` are in **cents** (divide by 100 for dollars)
- `volume_24h_fp` is cents; `volume_24h` is already dollars — prefer `_fp/100`, fall back to raw
- Multi-outcome detection: `markets.length > 2`
- PEM key normalization in server.js handles any secret storage format
- Outcome rows are paginated 10-at-a-time via `buildOutcomesHtml`/`window._outcomePages`
- `tip(text, key)` wraps jargon in a tooltip span using the GLOSSARY map
- `calcAnalyticsRow(label, prob, ask, bid)` computes EV/Kelly/spread/break-even for one outcome
- `analyticsCard(rows, timeLeft)` renders the TRADER ANALYTICS card
- `plainEnglishRules(text)` strips legal language from contract rules
- `whatsTheBetCard(text)` renders the "WHAT'S THE BET?" explainer card
- `betSimulatorHtml(pct)` renders bet calculator; `updateBetSim()` handles live updates
- Timeline date labels: Kalshi uses "Trading opens" / "Betting closes" / "Expected resolution"; Polymarket uses "Start date" / "End date" / "Expected resolution"
- `infoRow(key, val)` auto-adds glossary tooltips when the key matches a GLOSSARY entry
- Probability `(est.)` tag: shown on Kalshi outcomes when `last_price_dollars` is absent and the probability is derived from bid/ask midpoint
- Stats display: missing values show "—" instead of "$0" or empty

## Secrets
- `KALSHI_API_KEY_ID` — Kalshi API key member ID
- `KALSHI_PRIVATE_KEY` — RSA private key for JWT signing

There is deliberately **no** `ANTHROPIC_API_KEY`. See below.

## Settlement Desk — user-supplied API key only

AI analysis is billed to the user, never to Predara. Predara holds no Anthropic
key: `/api/settlement-review` reads the caller's key from the
`x-anthropic-api-key` request header and **nothing else**. There is no
environment-variable fallback, and neither entrypoint reads
`process.env.ANTHROPIC_API_KEY`. Do not reintroduce one — it would put every
user's AI usage on Predara's bill.

The key is used for one upstream call and is never logged, persisted, or echoed
back in a response.

- Key format is validated (`sk-ant-...`) before use; a malformed key is a 400.
- A missing key is **not** fatal at request entry — only on the slow path. Settlements
  the platform APIs confirm on their own (the fast path) still resolve with no key
  at all, which is most of them.
- Responses that need the user to act on a key carry `needsKey: true` — sent when no
  key was supplied and when Anthropic returns 401/403. A 429 (rate limit / out of
  credit) is the user's own account, so it reports the problem without asking for a
  new key. The client opens its key panel whenever `needsKey` is set.
- Client side (`settlement.html`): the key is stored in `localStorage` under
  `predara-anthropic-key` — per browser, no account required — never written into
  case history, and shown masked.

Both `api/settlement-review.js` (production) and `server.js` (local dev) implement
this identically — change them together.

## Deployment
- Local development: `npm start` (`node server.js`) on port 5000
- Vercel: production (predara.org), serving the `api/` serverless functions

## Gemini Prediction Markets

Predara is a **read-only** consumer of Gemini's Prediction Markets API. All of it
lives in `lib/gemini.js`; `api/gemini*.js` and `server.js` are only HTTP shells.

### Implemented (public, no API key)

| Route | Upstream | Purpose |
|---|---|---|
| `/api/gemini?ticker=&pageUrl=` | `GET /events/{ticker}` | Event definition, contracts, prices, order books. Also resolves the contract T&C URL. |
| `/api/gemini-events?status=&category=&search=&limit=&offset=` | `GET /events` | Paginated event discovery. |
| `/api/gemini-strike?ticker=` | `GET /events/{ticker}/strike` | Strike / threshold info. |
| `/api/gemini-combos[?symbol=]` | `GET /combos`, `GET /combos/{symbol}` | Combo contracts and their legs. |

### Deliberately NOT implemented

Order entry (`order.place`, `order.cancel`, `order.cancel_session`), positions,
order history, `terms/status` and `terms/accept`, combo creation, subaccounts,
and the entire WebSocket surface (`wss://ws.gemini.com`). These all require
account-scoped API keys and would make Predara an execution venue rather than an
analyzer. Do not add them without an explicit product decision — they carry key
custody, blast-radius, and compliance obligations that nothing in the current
architecture is built for.

### Domain rules that are easy to get wrong

- **Identifiers are not interchangeable.** An event ticker (`FEDJAN26`), a
  contract ticker (`DN25`), and an `instrumentSymbol` (`GEMI-FEDJAN26-DN25`) are
  three different things. Use `instrumentSymbol` **verbatim** as returned — never
  build one by concatenating parts.
- **Prices are decimal strings.** Gemini returns prices and quantities as strings
  and the docs require preserving that precision. Use `gemini.toNumber()` at the
  point of arithmetic and keep the original string for display.
- **Contracts are defined in YES space.** The outcome (`yes` / `no`) is exposure,
  and is selected separately from the symbol; it is *not* the order direction.
  Public order-book depth is normalized in YES space — derive the NO side with
  `gemini.complementPrice()` (`1 - yesPrice`), not by assuming a second book.
- **Price is *implied* probability.** `$0.65` reads as ~65% given a $1 settlement,
  but that is a reading of the current market, not an objective probability. YES
  and NO need not sum to exactly $1.00 because of spread, fees, and imbalance.
- **A null strike is not an error.** For crypto Up/Down contracts the strike is
  only captured at `availableAt` (~5 min before expiry on 5M contracts). The
  proxy marks this with `_pending`.
- **Strict vs inclusive thresholds decide ties.** `over` (`>`) and `over_or_equal`
  (`>=`) settle an exact tie to opposite sides. `describeStrikeType()` spells this
  out rather than glossing both as "above".
- **Combos settle multiplicatively.** A combo pays $1.00 only if *every* leg
  settles YES, so its fair value under independence is the product of leg prices
  (`comboFairValue()`). The gap between that anchor and the traded price is the
  market pricing correlation between legs — a real signal, not noise.
- **Combos do not net against their legs.** A combo and its underlying contracts
  are separate instruments with separate books and separate positions.
- **Ticker parsing is best-effort.** Automated markets (crypto, sports, weather,
  commodities) have deterministic formats; politics and custom markets do not.
  `parseTicker()` returns `kind: "other"` rather than guessing — callers must fall
  back to the event payload.
