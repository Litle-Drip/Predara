---
name: testing-predara-ui
description: How to run and end-to-end test the Predara web app locally (Analyze, Discover, Settlement Desk), including known pitfalls around /api/discover payload shape, mobile-width emulation, and public-data-only flows.
---

# Testing the Predara UI locally

## Setup
- No build step (vanilla JS frontend). Start the server detached so it survives shell teardown between phases:
  `cd <repo> && setsid nohup node server.js > /tmp/server.log 2>&1 < /dev/null &`
- App: http://localhost:5000/index.html (Analyze/Discover/Watchlist/Calendar/Tools/Rewards),
  Settlement Desk: http://localhost:5000/settlement.html
- Unit tests: `node --test` (or `npm test`).
- Polymarket, Gemini and MLB feeds are public — Analyze, Discover and Settlement Desk audits of
  Gemini markets all work with no credentials. Only the Rewards tab's live Kalshi programs and
  Kalshi market analysis need `KALSHI_API_KEY_ID` / `KALSHI_PRIVATE_KEY`; without them Rewards
  degrades to a "Couldn't load live Kalshi programs" notice plus static reference content (expected).
- Anthropic key is optional; settlements whose winner is not derivable from the public API will ask
  for an Anthropic API key instead of resolving.

## Things worth checking every time
- `curl -s localhost:5000/api/discover | head -c 200` must show top-level `generatedAt` and
  `platforms`. If it shows `{"value":{...},"fromCache":...}` the `cached()` envelope from
  `lib/guard.js` leaked through `lib/discover.js:getDiscoveryFeed`, and the Discover tab will show
  "No market leaders are available right now" with the fallback header "Live public market data"
  instead of "Updated h:mm AM/PM". This regression has happened before; `tests/discover.test.js`
  asserts the public shape.
- Vercel Hobby allows at most 12 functions in `api/`. Check `ls api/*.js | wc -l` before adding one;
  `/api/discover` is served in production via a `vercel.json` rewrite to
  `/api/gemini-events?view=discover`, while `server.js` handles it directly locally.
- Discover recovery state is easy to exercise for real: with the Discover tab loaded, kill the server
  (`pkill -f "node server.js"`), click **Refresh** → expect "Cross-venue leaders are temporarily
  unavailable" with a **Retry** button and the Gemini catalog still shown; restart the server and
  click **Retry** to confirm leaders come back.
- Settlement Desk: type a ticker like `SOL05M2608271250` (format `<ASSET><series>M<yymmddhhmm>`) to
  exercise the CONFIRMED path; a malformed/nonexistent ticker should yield a readable
  "Gemini API error: 404" card, not a stack trace.
- Check `browser_console` after navigating all tabs — the app should log nothing.

## Mobile-width emulation
Chrome cannot be resized narrower than ~530px wide, which is still under the app's
`max-width: 560px` breakpoint, so mobile CSS does activate:
`wmctrl -r :ACTIVE: -b remove,maximized_vert,maximized_horz && wmctrl -r :ACTIVE: -e 0,0,0,420,780`
Restore with `wmctrl -r :ACTIVE: -b add,maximized_vert,maximized_horz`. Beware stale extra Chrome
windows overlapping the recording — close them (or verify with `wmctrl -l`) before recording.

## Keyboard/a11y spot checks
Click a non-focusable area of the header, then Tab: focus should reach the Analyze/Settlement Desk
pills, the `%` and theme buttons, then the tab bar; Enter must activate the theme toggle, the tabs,
and Discover market rows (rendered as real `<button>` elements).
