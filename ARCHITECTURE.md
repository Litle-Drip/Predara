# Predara — Prediction Market Analyzer

## Overview
Node.js web app that analyzes Kalshi, Polymarket, Gemini, and Coinbase prediction markets. Users paste a market URL and get a full breakdown of what they're betting on, resolution rules in plain English, a bet calculator, odds, volume, liquidity, and trader analytics. Gemini URLs route through Gemini's own public Prediction Markets REST API (`api.gemini.com/v1/prediction-markets`). Coinbase has two product surfaces: `predict.coinbase.com/markets/<slug>` (lowercase slugs) routes through the Polymarket gamma API, while `www.coinbase.com/predictions/event/<TICKER>` (uppercase tickers) routes through the Kalshi API.

## Architecture
- **lib/** — Shared platform logic, imported by both `api/` and `server.js` so the two entrypoints cannot drift. `lib/guard.js` gates every `/api/*` route; `lib/history.js` fetches real price history; `lib/notify.js` relays alert webhooks; `lib/kalshi-auth.js` is the shared Kalshi request signer. `lib/gemini.js` is the single source of truth for the Gemini Prediction Markets API; `lib/serverless.js` is the CORS/JSON shell for the read-only Vercel functions. `lib/polymarket.js` is the Polymarket event lookup, including the polymarket.us venue fallback; `lib/match.js` and `lib/cross-platform.js` answer "where else is this event listed?".
- **server.js** — Local dev HTTP server on port 5000 / 0.0.0.0. Proxies API calls to Kalshi (authenticated via RSA-signed JWT), Polymarket (public gamma API) and Gemini (public, unauthenticated). Serves static files.
- **app.js** — Client-side rendering. Detects platform from URL, fetches data via `/api/kalshi` or `/api/polymarket`, renders: "WHAT'S THE BET?" explainer, outcomes, bet simulator, resolution rules, timeline, trader analytics, glossary tooltips, and volume stats.
- **index.html** — Single-page app shell with all CSS inline.
- **kyle.html / kyle.js** — "Kyle", the customer-support event brief (third tab, after Analyze and Settlement Desk). A Gemini CS agent pastes what a customer sent them — an event name in their own words, a ticker, or a gemini.com link — and gets a plain-English brief: what the event is, whether it is open / closed-awaiting-result / settled / voided, the dates, the winning outcome once it settles, and the things to check before replying. It reads the existing read-only routes (`/api/gemini` for one event, `/api/gemini-markets?resource=events&search=` for a name search) and adds no upstream surface. Everything above the DOM section of `kyle.js` is pure and covered by `tests/kyle.test.js`.
- **api/*.js** — Vercel serverless functions for predara.org production. Keep these as thin HTTP shells: put the logic in `lib/` so `server.js` runs the same code path locally. `api/kalshi.js` has not been migrated to `lib/` yet — change it only with care, since production deploys directly from this directory. `api/polymarket.js` was migrated when the venue fallback landed; its logic is in `lib/polymarket.js`.

## Finding the same event on another venue

The compare view holds three markets, and until `/api/match` existed the reader
had to find all three URLs by hand. That is harder than it sounds. The 2026
Spanish Grand Prix is listed as:

| Venue | Identifier | Title |
| --- | --- | --- |
| Kalshi | `KXF1RACE-SPAGP26` | Spanish Grand Prix Winner |
| Gemini | `F1-MADGP-WIN-20260913` | Madrid Grand Prix Winner |
| Polymarket | `f1-thsgp-2026-09-13-w` | F1 Spanish GP Winner |

No two of those identifiers share a substring, and two of the three titles name
different cities — the race moved to Madrid but kept the Spanish GP slot. Ticker
matching cannot work here, so `lib/match.js` scores three signals instead and
`lib/cross-platform.js` does the fetching. The rules that keep it honest:

- **Nothing is auto-selected.** Candidates are returned ranked, with a
  confidence band and the reasons behind it, and the reader clicks one. A wrong
  fuzzy match would put two different events side by side and label the gap
  between them an arbitrage, which is worse than finding nothing.
- **A shared date alone is not evidence.** Hundreds of unrelated markets close
  on any given day, so a candidate agreeing on neither the words nor the outcomes
  is rejected rather than scored.
- **A date the venues disagree about caps the result at "weak".** Every F1 race
  of the season shares a driver list and most of a title, so outcome and title
  overlap alone rank *last* week's race as a confident match for this week's.
  The cap rather than a rejection is deliberate: long-horizon markets genuinely
  carry different end dates on different venues.
- **The market kind is disqualifying, not a deduction.** A race winner and a
  podium market share a date, a sport and twenty drivers, and are completely
  different bets. `marketKind()` reads both titles; when both declare a kind and
  the kinds differ, the candidate is dropped.
- **Only signals both sides published get a vote.** Kalshi's event listing
  carries no outcome list, so weights are renormalized over the signals that
  exist — otherwise an absent list would score as a disagreement and bury every
  Kalshi candidate. The leading Kalshi candidates are then re-fetched in full
  and ranked a second time, because a title alone cannot separate one Grand Prix
  from another.
- **Venues fail independently.** Each search is isolated and reports its own
  error; one venue being down, unconfigured or rate limited must leave the other
  two answering, since a partial answer is the entire point.
- **Retrieval is broad; only scoring is strict.** Each search term is sent as
  its own query and the results are unioned. The first implementation joined
  them into one query and found nothing, which is obvious in hindsight: the
  premise of the feature is that venues describe the same event in *different
  words*, so demanding a listing contain all of the source venue's words asks
  for the one thing that cannot be assumed. Searching Gemini for
  `"spanish winner gp"` returned nothing while "Madrid Grand Prix Winner" sat
  there; `grand` on its own finds it. Terms a venue does not share cost nothing —
  they return nothing — and `scoreMatch()` discards whatever does not hold up.
- **Search with the venues' words, compare with normalized ones.**
  `titleTokens()` aliases "grand prix" to "gp" so two titles can be compared;
  `searchTokens()` deliberately does not, because the listing being searched for
  says "Grand Prix" and contains no "gp" at all. Using the aliased form as a
  query made the target literally unfindable.
- **A competitor's name is the most portable search key there is.** Every book
  listing a race lists Verstappen, whatever it calls the race, so the leading
  outcome goes into the term list alongside the title's words.

Kalshi publishes no text search, so `kalshiIndex()` pages its open events into a
local index behind a page cap and a wall-clock budget. An index cut short by
either is cached for 30 seconds instead of 5 minutes — it is missing events, and
a reader searching for one of them should not be told "not found" for the next
five minutes.

`tests/match.test.js` covers the scoring (including the Spanish/Madrid case, the
podium market and last week's race) and `tests/cross-platform.test.js` covers
the orchestration, paging and caching. Neither needs a network.

## Reading a venue's "not found"

Two error paths used to describe a working exchange as a broken one, and both
are now fixed in shared code rather than at the call site:

- **A Polymarket slug that does not exist is a 404, not a 502.** gamma answers
  `200` with an empty array for a slug it has never heard of. Reporting that as a
  bad gateway told readers the exchange was down and had them retry a request
  that could never succeed. `lib/polymarket.js` names the slug instead.
- **polymarket.us is a different exchange Predara cannot read.** The
  US-regulated venue lists its own events under its own slugs, which the `.com`
  gamma API does not serve. A `gamma-api.polymarket.us` host was guessed for it
  and probed from production: it does not resolve. A `.us` link is therefore
  looked up on `.com` only, in case the slug happens to exist on both, and
  otherwise the reader is told plainly that the venue is unsupported and pointed
  at the match card — not "event not found", which invites them to re-paste a
  URL that can never work. Do not add a host to `VENUE_HOSTS` on a guess: a
  hostname that does not exist costs every reader a failed DNS lookup and tells
  them nothing.
- **The input hint and the analyzer must agree on what is supported.** The hint
  matched `polymarket.com` while `analyze()` matches `polymarket`, so a
  polymarket.us URL was called an unrecognized platform and then analyzed
  anyway. Paste-to-auto-analyze deliberately still excludes it: firing an
  analysis that can only report an unsupported venue is worse than letting the
  reader press the button.
- **A Gemini instrument symbol is not an event ticker.** `GEMI-{event}-{contract}`
  is what a customer copies off their own position. `analyze()` unwrapped it and
  the compare view did not, so pasting one into compare 404'd on a market that
  was open and trading. `geminiUrlFromTicker()` in `utils.js` is now the single
  copy both use — the same unwrapping Kyle does in `kyleTickerCandidates()`.

## Shipping a change to a reader who has been here before

`index.html` busts client caches with a `?v=` on every `<script>`, and **every
tag carries the same number**. Changing a file without bumping it ships
nothing: the browser serves the copy it already has, and the reader runs a
version of the app that no longer exists on the server.

That is not hypothetical, and the symptom does not look like a caching problem.
The cross-platform match release edited `compare.js` and left it requested as
`compare.js?v=22`, so returning readers ran the old error handling against the
new API and saw "Polymarket API 404" — the old client's string — while the new
server was sending a full explanation. The old client also never sent the
`venue` parameter, so the polymarket.us handling that same release added was
never reached, and the thing the release existed to fix had not in fact been
tested by anyone.

One shared version makes this a single number to move rather than a per-file
judgement about what a change "really" touched — the judgement that was got
wrong. Bump it together with `CACHE_NAME` in `sw.js`.
`tests/asset-versions.test.js` enforces the shared version and that every
script is in the service worker's asset list.

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
- **Verified against one real response.**
  `tests/fixtures/gemini-settled-categorical.json` is a trimmed but verbatim
  capture of `F1-ITAGP-WIN-20260906`. Before it, every field name in Kyle was
  inferred from what `adapters.js` happened to read. It confirmed
  `resolutionSide: "yes"|"no"`, `status: "settled"`, and `expiryDate` as the
  close; it also showed there is no top-level `sport`, no `settlementValue`
  (the `settlement` key is an empty object), and that prices nest under
  `prices.buy` / `prices.sell` rather than the flat `bestAsk` the code reads.
  Do not hand-edit the fixture to make a test pass — recapture it.

  Two more captures followed: `gemini-live-categorical.json` (the only observed
  populated price book) and `gemini-settled-podium.json` (a top-N event). Between
  them they settled the two questions that were open:

  - **`template`, never `type`, says whether outcomes are exclusive.** A
    race-winner market and a podium market both carry `type: "categorical"`, so
    `type` cannot tell them apart and trusting it would have repeated the
    price-heuristic error exactly. `template` does: `"categorical"` on the
    winner, `"binary"` on the podium, whose contracts each carry their own
    `strike` as well. `"categorical"` is believed on its own; `"binary"` is
    believed only when every contract also has a strike, because a head-to-head
    market has never been observed and might also be `"binary"`. This is the
    first thing that answers exclusivity on a market that has not settled yet.
  - **Prices are read ask-first.** A live book carries `bestAsk`, `bestBid` and
    `lastTradePrice` at once, and gemini.com displays the ask as the contract's
    "Yes %". Reading `lastTradePrice` first showed 31% for a contract Gemini was
    showing at 37%. The page has to agree with what the customer is looking at.
- **Gemini's status is the status.** Kyle never overrules the venue's own
  `status` with the agent's browser clock. When the published close time has
  passed but Gemini still reports the event open, that is a `conflict` state
  the agent is told to resolve on the event page — not a confident "trading has
  stopped". Telling a customer trading is over, on the strength of a clock, can
  cost them a position they wanted to exit.
- **Exclusivity is a fact or it is unstated.** `kyleExclusive()` answers only
  from an explicit flag, from a single yes/no contract, or from a settled
  event's own resolution sides. It used to sum contract prices, which was
  unsound by construction: the price fallback reads `bestAsk`, and in any real
  book the asks sum above 1 because of the spread, so genuinely exclusive
  markets read as "several can win" — systematically, on ordinary two-way
  sports markets. Do not reintroduce a price-derived answer.
- **Settlement is what a contract does, not what an account has received.**
  Kyle reads a resolution state and has no visibility into credits, so it says
  a contract "settles at" a value and tells the agent to check the account. The
  value itself comes from `kyleSettlement()`, which reads the payload rather
  than assuming $1 — `lib/gemini.js` carries a `settlementValue` parameter, so
  $1 is a default, not a guarantee. When it is absent the copy says "its full
  settlement value" instead of inventing a number for a customer's email.
- **Never print a rounded certainty.** A price of 0.9999 rounds to "100%",
  which an agent will repeat as certainty about an undecided market. Only a
  settled contract may show 0 or 100; everything else clamps to `>99%`/`<1%`.
  The derived NO row complements the raw price, not the rounded percentage, and
  is labelled "calculated" because Gemini quotes no NO book.
- **The copied block is the only part of Kyle that leaves the building**, so it
  carries its own provenance: source, absolute UTC read time, and a line saying
  it is event data rather than a statement of anyone's account. Every timestamp
  in it is absolute — "settled 1 hour ago" becomes false the moment the text is
  forwarded. Relative times stay on screen, where they are true.
- **A reading has an age.** The brief records `retrievedAt`, the page states it,
  and past five minutes the line escalates and asks the agent to re-read before
  quoting. Prices and status are a snapshot; a tab open all afternoon otherwise
  looks exactly as authoritative as one opened a second ago.
- **Never guess on the agent's behalf.** An event marked settled with no winning
  contract published is an alert to escalate, not an inference from prices. A
  missing close date is stated as missing. An agent repeating an invented
  settlement date to a customer is worse than one saying "I need to check".
- **No trading language.** No EV, Kelly, edge, spread or fee model. A percentage
  is labelled as a price traders are paying, with an explicit "do not quote this
  to a customer as odds".
- **When a contract is named, that contract is the answer.** An agent pasting
  an instrument symbol is holding a customer's position, so `kyleFocusAnswer()`
  puts its verdict — won, lost, still trading at a price — in its own panel at
  the top, and demotes the event's own result to a supporting line. On a
  22-driver podium the pasted contract used to be the last row of a collapsed
  list while the headline announced three winners the customer did not hold.
  The event line goes `concise` in that case: saying "check the customer's
  account" twice in two adjacent paragraphs gets neither read. The copied ticket
  text keeps the full wording, because it travels without the page around it.
- **The answer is the first thing on the page.** `kyleHeadline()` writes one
  sentence in the words the agent will use ("Finished — Verstappen, Norris and
  Piastri won. Those paid $1 each; every other contract paid $0."), and the
  ticket summary opens with the same sentence. Everything below it is reference
  material for the follow-up question, so it is dense rather than explanatory:
  a two-column fact grid, no row repeating the title or ticker already in the
  header, the market-type explainer behind a disclosure, and a long outcome
  field collapsed to six — with winners and any pasted contract pinned visible.
- **The raw API record is a first-class link.** Agents open
  `api.gemini.com/v1/prediction-markets/events/{TICKER}` on essentially every
  ticket: it is the source Kyle itself reads, so it is what to quote when a
  customer disputes the page and what to attach when escalating. It appears as
  a link, as selectable text with a copy button (agents paste it more often
  than they open it), and as a line in the ticket summary. It is built from the
  ticker Kyle *resolved*, never from what the agent pasted — a contract symbol
  would 404 the same way the original lookup did. The links sit directly under
  Details, with the identifiers and dates the agent is acting on, rather than
  below a field of outcomes they would have to scroll past.

  `kyleTickerCandidates()` must keep stripping until one segment remains, not
  two. Most non-sports event tickers have no hyphen at all, so their instrument
  symbols are only two segments after the venue prefix
  (`GEMI-USOPENM26-ALCARAZ`); stopping at two silently excluded every one of
  them.
- **Themes are Kyle's alone.** Four of them (`gemini` default, `mars`, `seas`,
  `astro`) set the same token names the shared shell reads, stored under
  `predara-kyle-theme` so picking one here does not change the Analyze or
  Settlement pages. The three illustrated themes layer artwork from
  `kyle-themes/` under a scrim in that theme's colour; each also carries a
  `--k-fallback` gradient so the theme is complete and readable with the image
  missing or still loading. Cards stay near-opaque: the art is atmosphere and
  must never compete with the brief.

  Each theme carries three accent tokens, because one colour cannot do all
  three jobs. `--orange` is the brand accent and appears only where nothing
  sits on top of it — borders, focus rings, tints. `--k-fill` is the button
  background and `--k-on-fill` the text on it; `--k-ink` is the accent used as
  small text on a card. A brand colour bright enough to read as the brand is
  rarely dark enough to carry white 12px text: Gemini blue `#0093F5` with white
  is 3.2:1 against the 4.5:1 WCAG AA needs at that size, and all four themes
  failed the same check before the split. `tests/kyle.test.js` computes the
  ratio rather than trusting the eye.
- **Every number is either a fact or an identifier.** Tickers and instrument
  symbols are there to be pasted into a ticket; the hand-off card emits the whole
  brief as plain text for exactly that.

## Page Layout Order (beginner-first)
1. Event title + urgency banner
2. "WHAT'S THE BET?" card — plain-English explanation of what you're betting on
3. Outcomes & probability
4. "SAME EVENT ON OTHER PLATFORMS" — where else this event is listed, one click from a comparison (sits under the odds it invites you to compare, not at the foot of the page where a cross-venue price gap would go unseen)
5. Bet calculator — interactive "$X bet → win $Y / lose $X" simulator
6. "HOW IT RESOLVES" — resolution rules in plain English (contract jargon removed)
7. Timeline
8. Trader Analytics (EV, Kelly, Break-even, Spread)
9. Volume/Liquidity stats

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
- **Same event on other platforms**: `crossmatch.js` asks `/api/match` where else the analyzed event is listed and offers each candidate one click from the compare view. Ranked, never auto-selected — see "Finding the same event on another venue" above.

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
