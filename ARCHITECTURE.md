# Predara — Prediction Market Analyzer

## Overview
Node.js web app that analyzes Kalshi, Polymarket, Gemini, and Coinbase prediction markets. Users paste a market URL and get a full breakdown of what they're betting on, resolution rules in plain English, a bet calculator, odds, volume, liquidity, and trader analytics. Gemini URLs route through Gemini's own public Prediction Markets REST API (`api.gemini.com/v1/prediction-markets`). Coinbase has two product surfaces: `predict.coinbase.com/markets/<slug>` (lowercase slugs) routes through the Polymarket gamma API, while `www.coinbase.com/predictions/event/<TICKER>` (uppercase tickers) routes through the Kalshi API.

## Architecture
- **lib/** — Shared platform logic, imported by both `api/` and `server.js` so the two entrypoints cannot drift. `lib/guard.js` gates every `/api/*` route; `lib/history.js` fetches real price history; `lib/notify.js` relays alert webhooks; `lib/kalshi-auth.js` is the shared Kalshi request signer. `lib/gemini.js` is the single source of truth for the Gemini Prediction Markets API; `lib/serverless.js` is the CORS/JSON shell for the read-only Vercel functions.
- **server.js** — Local dev HTTP server on port 5000 / 0.0.0.0. Proxies API calls to Kalshi (authenticated via RSA-signed JWT), Polymarket (public gamma API) and Gemini (public, unauthenticated). Serves static files.
- **app.js** — Client-side rendering. Detects platform from URL, fetches data via `/api/kalshi` or `/api/polymarket`, renders: "WHAT'S THE BET?" explainer, outcomes, bet simulator, resolution rules, timeline, trader analytics, glossary tooltips, and volume stats.
- **index.html** — Single-page app shell with all CSS inline.
- **kyle.html / kyle.js** — "Kyle", the customer-support event brief (third tab, after Analyze and Settlement Desk). A Gemini CS agent pastes what a customer sent them — an event name in their own words, a ticker, or a gemini.com link — and gets a plain-English brief: what the event is, whether it is open / closed-awaiting-result / settled / voided, the dates, the winning outcome once it settles, and the things to check before replying. It reads the existing read-only routes (`/api/gemini` for one event, `/api/gemini-markets?resource=events&search=` for a name search) and adds no upstream surface. Everything above the DOM section of `kyle.js` is pure and covered by `tests/kyle.test.js`.
- **api/*.js** — Vercel serverless functions for predara.org production. Keep these as thin HTTP shells: put the logic in `lib/` so `server.js` runs the same code path locally. `api/kalshi.js` and `api/polymarket.js` have not been migrated to `lib/` yet — change them only with care, since production deploys directly from this directory.

## Service worker caching

`sw.js` splits its strategy by what is being requested, and the split matters:

- **Pages are network-first**, falling back to the cache only when the fetch
  fails. A page carries the site's navigation, so serving a stale one strands
  the user on an old version of the app — that is how the Kyle tab went missing
  from the Settlement Desk header for anyone who had opened that page before
  Kyle shipped. Cache-first handed them the old HTML and refreshed it only in
  the background, so a new tab did not appear until their *second* visit after
  a deploy, and never for someone who visited once. Pages are small and change
  on every deploy; there is nothing to gain by serving them from cache first.
- **Assets are cache-first**, refreshed behind the response. This is where the
  speed and the offline shell actually come from, so it stays.
- **Bump `CACHE_NAME` on any change returning users must not miss.** Old caches
  are deleted on activate, which is the only thing that clears an entry already
  poisoned with stale HTML.

`tests/navigation.test.js` asserts both strategies and that all three pages link
to each other, because "the link is right there in the markup" was true the
whole time the tab was unreachable.

## Kyle — the support brief

Kyle is not a smaller Analyze page and must not drift into one. Its reader is a
support agent mid-ticket who has never traded a prediction market, so:

- **State first.** Open / closed-awaiting-result / settled / voided is the top of
  the page, because it decides the whole answer: "where is my money?" means
  something different in each. `kyleStatus()` takes the status string, the
  resolution timestamp and the per-contract `resolutionSide` as three votes,
  since Gemini spells the state differently across payloads.
- **Resolve what the agent has, not what the API wants.** A customer sends the
  link out of their browser (`/predictions/{TICKER}/{slug}?query`) or the
  instrument symbol off their position (`GEMI-{EVENT}-{CONTRACT}`); neither is an
  event ticker. `_kTickerFromUrl()` reads the segment after `predictions` rather
  than the last one, and `kyleTickerCandidates()` unwraps a symbol to its event
  ticker. Each candidate is a real lookup and the first that exists wins —
  nothing is derived blindly. A pasted contract symbol is then tagged in the
  outcome list, because that contract is the customer's position.
- **Do not assume one winner.** A race-winner market has exactly one; a podium
  market pays every driver who finishes top three. `kyleExclusive()` trusts an
  explicit flag, then falls back to the price total (exclusive contracts are
  priced as shares of one outcome and sum near 100%; independent top-N contracts
  sum far past it), and returns null rather than guessing when neither is
  available. `kyleWinner()` is therefore the *single* winner or null.
- **Never guess on the agent's behalf.** An event marked settled with no winning
  contract published is an alert to escalate, not an inference from prices. A
  missing close date is stated as missing. An agent repeating an invented
  settlement date to a customer is worse than one saying "I need to check".
- **No trading language.** No EV, Kelly, edge, spread or fee model. A percentage
  is labelled as a price traders are paying, with an explicit "do not quote this
  to a customer as odds".
- **The answer is the first thing on the page.** `kyleHeadline()` writes one
  sentence in the words the agent will use ("Finished — Verstappen, Norris and
  Piastri won. Those paid $1 each; every other contract paid $0."), and the
  ticket summary opens with the same sentence. Everything below it is reference
  material for the follow-up question, so it is dense rather than explanatory:
  a two-column fact grid, no row repeating the title or ticker already in the
  header, the market-type explainer behind a disclosure, and a long outcome
  field collapsed to six — with winners and any pasted contract pinned visible.
- **Themes are Kyle's alone.** Four of them (`gemini` default, `mars`, `seas`,
  `astro`) set the same token names the shared shell reads, stored under
  `predara-kyle-theme` so picking one here does not change the Analyze or
  Settlement pages. The three illustrated themes layer artwork from
  `kyle-themes/` under a scrim in that theme's colour; each also carries a
  `--k-fallback` gradient so the theme is complete and readable with the image
  missing or still loading. Cards stay near-opaque: the art is atmosphere and
  must never compete with the brief.
- **Every number is either a fact or an identifier.** Tickers and instrument
  symbols are there to be pasted into a ticket; the hand-off card emits the whole
  brief as plain text for exactly that.

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

## Betting math — one source of truth

`utils.js` holds the fee and execution-price model that every calculator on the
page reads from, so the bet calculator, the edge calculator and the analytics
card can never quote three different numbers for the same trade.

- **Price off the book you would hit, never the midpoint.** `executionPrice()`
  returns the ask for YES and `1 - bid` for NO. The midpoint understates the cost
  of both sides by half the spread, which on a thin market is the whole edge.
  When no book is published it falls back to the midpoint and sets `isEstimate`,
  which the UI must surface.
- **Fees are charged on entry, win or lose.** `feeFor()` implements Kalshi's
  published `roundup(0.07 x C x P x (1-P))`, which peaks at 1.75c per contract at
  50c — it is emphatically not a flat percentage of profit. A win pays out minus
  the fee AND a loss costs the stake plus the fee.
- **A fee we cannot reproduce is reported as unknown.** `FEE_MODEL` entries carry
  `known: false` for venues that publish no formula, and the UI says "not
  included" rather than showing an invented rate. Do not fill these in with a
  guessed percentage; a made-up fee is worse than an absent one because it looks
  authoritative.
- **EV and Kelly require the USER's probability.** They are undefined against the
  market's own price: EV measured that way is always minus half the spread and
  Kelly is always ~0, on every market. `calcAnalyticsRow()` therefore returns
  break-even and spread only, and `renderAnalyticsEdge()` fills EV and Kelly from
  the estimate the reader types into "What's your edge?". Do not reintroduce an
  EV computed from `prob` — that was the original bug.
- **An estimate belongs to one outcome.** On a multi-outcome market only the row
  the estimate was made for gets EV and Kelly.
- **Say when a number is clamped.** The Kelly bar caps at 25% of bankroll and
  prints the uncapped figure alongside it.

Covered by `tests/betting-math.test.js`. These are the functions that hand a
reader a number they may act on, so changes here need tests.

## Price history

`PRICE HISTORY` draws the **platform's own** time series — Kalshi candlesticks
(`/series/{s}/markets/{t}/candlesticks`) and the Polymarket CLOB
(`/prices-history`) — via `/api/history`, which both entrypoints serve from
`lib/history.js`. The identifiers travel on `normalized.historyRef`.

Gemini publishes no public history endpoint, so its `historyRef` is `null`. The
localStorage snapshot series (`predara-ts:*`) survives only as a fallback for
that case, and the chart labels it as the reader's own page views rather than
letting it pass as market data.

## /api/* is not a public API

Every `/api/*` route proxies an upstream that costs Predara something — the
Kalshi routes are signed with Predara's own RSA key, and all of them consume a
shared rate limit. `lib/guard.js` enforces three things on all of them:

- **Origin allowlist.** CORS echoes the caller's origin only when it is
  allowlisted, and never `*`. A wildcard let any site use predara.org as its
  backend. An absent `Origin` is allowed, because browsers omit it on
  same-origin GETs and send it in exactly the cross-site case being blocked.
- **Response cache.** Market payloads are cached for ~15s (history for ~60s), so
  a burst of readers on a trending market is one upstream call, not hundreds.
  Errors are never cached.
- **Rate limit.** Fixed window per forwarded IP. Process-local, so on Vercel it
  is a cost dampener per instance rather than a distributed quota.

Do not add an `/api` route that bypasses `applyGuard()`.

## Alerts and webhook relay

Price alerts are checked by `startAlertPoller()` in the page, every 3 minutes,
across every alerted market — not only the one on screen. This covers the time a
Predara tab is open and nothing more, and the UI says exactly that. There is no
server-side push and no service-worker polling: a `CHECK_ALERTS` handler used to
sit in `sw.js` but nothing ever posted that message, so it was removed.

Delivery goes through `/api/notify` rather than a fetch from the page because
Slack's incoming webhooks reject cross-origin browser requests. `lib/notify.js`
pins the reachable hosts to Discord, Slack and Telegram — without that allowlist
the relay is an SSRF hole and an open spam cannon. Destinations arrive with each
request, are used for one POST, and are never logged or stored.

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

Predara is a **read-only** consumer of Gemini's Prediction Markets API. Transport,
validation and the event/strike/combo calls live in `lib/gemini.js`;
`lib/gemini-public.js` adds the by-name resource router (event feeds, categories,
volume, reward programs) with a short-lived response cache, delegating strike and
combo lookups back to `lib/gemini.js`. `api/gemini*.js` and `server.js` are only
HTTP shells. Live quotes are the one thing the browser fetches directly, over the
public market-data WebSocket (`gemini-live.js`).

### Implemented (public, no API key)

| Route | Upstream | Purpose |
|---|---|---|
| `/api/gemini?ticker=&pageUrl=` | `GET /events/{ticker}` | Event definition, contracts, prices, order books. Also resolves the contract T&C URL. |
| `/api/gemini-events?status=&category=&search=&limit=&offset=` | `GET /events` | Paginated event discovery. |
| `/api/gemini-strike?ticker=` | `GET /events/{ticker}/strike` | Strike / threshold info. |
| `/api/gemini-combos[?symbol=]` | `GET /combos`, `GET /combos/{symbol}` | Combo contracts and their legs. |
| `/api/gemini-markets?resource=…` | `GET /events/{newly-listed,upcoming,recently-settled}`, `/categories`, `/volume/{date}[/hourly]`, `/maker-rebate/rates`, `/liquidity-rewards/{config,events}`, `/terms`, and the delegated `strike`/`combos` | Resources the UI browses by name: Discover feeds and filters, the volume dashboard, and live reward-program data. |

Plus the public market-data WebSocket (`wss://ws.gemini.com/`), subscribed from
the browser for `{instrumentSymbol}@bookTicker`, `@depth5` and `@trade`. It is
unauthenticated, so it stays client-side rather than being proxied.

### Deliberately NOT implemented

Order entry (`order.place`, `order.cancel`, `order.cancel_session`), positions,
order history, `terms/status` and `terms/accept`, combo creation, subaccounts,
and the account-scoped WebSocket streams (order and position updates). These all
require account-scoped API keys and would make Predara an execution venue rather than an
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
- **Volume lands late.** `GET /volume/{date}` only covers completed UTC days, and
  the most recent one can still 404 hours later — the dashboard walks back a day
  at a time rather than reporting an error.
- **Category volume rows nest.** A row's `categoryPath` is a path, so deeper rows
  are sub-totals already counted in their parent; only sum `length === 1` rows.
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
