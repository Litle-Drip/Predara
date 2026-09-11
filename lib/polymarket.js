// ── Polymarket event lookup ───────────────────────────────────────────────────
// Shared by api/polymarket.js (Vercel) and server.js so the two entrypoints
// cannot drift, and so the two things this route used to get wrong stay fixed
// in one place:
//
//   1. **"Slug not found" is not a bad gateway.** gamma answers 200 with an
//      empty array for a slug it has never heard of. Reporting that as a 502
//      told readers the exchange was broken when their URL simply pointed
//      somewhere else, and sent them re-trying a request that could never
//      succeed. It is a 404, and it names the slug.
//   2. **polymarket.us is a different exchange.** The US-regulated venue lists
//      its own events under its own slugs (f1-thsgp-2026-09-13-w), which the
//      .com gamma API does not serve. A `.us` link is tried against the US
//      venue first and only then falls back to .com, and when neither has it
//      the reader is told the two are separate venues rather than being left
//      to conclude their link was malformed.

const { fetchJson } = require("./gemini") // plain HTTPS GET → { status, body }

// Ordered by which venue is most likely to hold the slug. The fallback matters:
// the two venues do share slugs for some events, and a reader who pastes a .us
// link for one of those should still get an answer.
const VENUE_HOSTS = {
  us:  ["gamma-api.polymarket.us", "gamma-api.polymarket.com"],
  com: ["gamma-api.polymarket.com"],
}

function isSafeSlug(str) {
  return typeof str === "string" && /^[A-Za-z0-9_\-\.]+$/.test(str)
}

// "us" for any polymarket.us URL, "com" otherwise. Exported so the browser and
// both servers agree on what a link means.
function venueFor(urlOrVenue) {
  return /polymarket\.us/i.test(String(urlOrVenue || "")) || String(urlOrVenue) === "us" ? "us" : "com"
}

// Resolves to { status, body } on success, or { status, error } — never throws.
// `body` is the raw upstream JSON so callers can pass it through untouched.
async function fetchEventBySlug(slug, venue = "com", deps = {}) {
  if (!isSafeSlug(slug)) return { status: 400, error: "Missing or invalid slug" }
  const get = deps.fetch || fetchJson
  const hosts = VENUE_HOSTS[venue] || VENUE_HOSTS.com

  // What each host actually said, so a "not found" can tell the reader whether
  // the US venue denied having the event or was never reachable in the first
  // place. Those are different problems with different fixes, and without this
  // both read as the same flat "not found".
  const attempts = []
  let lastFailure = null
  for (const host of hosts) {
    let result
    try {
      result = await get(`https://${host}/events?slug=${encodeURIComponent(slug)}`)
    } catch (err) {
      // A timeout is a 504, not a 502: the reader is told to try again in a
      // moment rather than that the market is unavailable, and the front end
      // already distinguishes the two.
      const timedOut = /timeout|timed out|ETIMEDOUT/i.test(err.message || "")
      attempts.push(`${host}: ${timedOut ? "timed out" : "unreachable"}`)
      lastFailure = timedOut
        ? { status: 504, error: "Polymarket API request timed out" }
        : { status: 502, error: err.message }
      continue
    }
    if (result.status !== 200) {
      attempts.push(`${host}: HTTP ${result.status}`)
      lastFailure = { status: result.status, error: `Polymarket API returned ${result.status}` }
      continue
    }
    let parsed
    try { parsed = JSON.parse(result.body) } catch { parsed = null }
    if (parsed === null) {
      attempts.push(`${host}: unreadable response`)
      lastFailure = { status: 502, error: "Invalid response from Polymarket API" }
      continue
    }
    // An empty array is a definitive "no such slug here", not a transport
    // failure — keep looking on the other venue before saying so.
    if (Array.isArray(parsed) && parsed.length === 0) {
      attempts.push(`${host}: no such slug`)
      lastFailure = { status: 404, error: notFoundMessage(slug, venue, attempts) }
      continue
    }
    if (!Array.isArray(parsed)) {
      attempts.push(`${host}: unexpected payload`)
      lastFailure = { status: 502, error: "Upstream returned an unexpected payload" }
      continue
    }
    return { status: 200, body: result.body }
  }
  return lastFailure || { status: 502, error: "Polymarket API unreachable" }
}

function notFoundMessage(slug, venue, attempts = []) {
  if (venue !== "us") return `No Polymarket event with slug "${slug}"`
  const trail = attempts.length ? ` (${attempts.join("; ")})` : ""
  return `No event with slug "${slug}" on polymarket.us or polymarket.com${trail}. ` +
    "polymarket.us is a separate US-regulated exchange — its listings are not always mirrored on polymarket.com."
}

module.exports = { fetchEventBySlug, venueFor, isSafeSlug, VENUE_HOSTS }
