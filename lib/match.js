// ── Cross-platform event matching ─────────────────────────────────────────────
// Decides whether an event on one venue is the *same real-world event* as an
// event on another, from nothing but the two public descriptions.
//
// This is harder than it sounds, and the 2026 Spanish Grand Prix is the reason
// this file exists. The same race is listed as:
//
//   Kalshi      KXF1RACE-SPAGP26        "Spanish Grand Prix Winner"
//   Gemini      F1-MADGP-WIN-20260913   "Madrid Grand Prix Winner"
//   Polymarket  f1-thsgp-2026-09-13-w   "F1 Spanish GP Winner"
//
// No two of those tickers share a substring, and two of the three titles do not
// even share the venue's name (the race moved to Madrid but kept the Spanish
// GP slot). Ticker matching cannot work here. What *does* line up is the close
// date, the outcome list (the same twenty drivers), and the kind of market
// being offered — and it takes more than one of those agreeing to be safe,
// because on any given Sunday hundreds of unrelated events share a date.
//
// Everything here is pure so it can be tested without a network: see
// tests/match.test.js. The fetching half lives in lib/cross-platform.js.

// Words that carry no identifying signal. Deliberately short — dropping a
// meaningful word costs more than keeping a meaningless one, because the score
// is an overlap ratio and every kept token dilutes it on both sides equally.
const STOPWORDS = new Set([
  "the", "a", "an", "of", "in", "on", "at", "for", "to", "and", "or", "by",
  "will", "be", "is", "are", "was", "were", "do", "does", "did", "with",
  "which", "who", "whom", "what", "when", "market", "markets", "event",
  "prediction", "predictions", "vs", "v", "versus", "this", "that",
])

// The kind of question being asked about an event. Two markets can share a
// date, a sport and a full outcome list and still be different bets — the race
// winner and the podium finishers are priced completely differently. When both
// titles declare a kind and the kinds disagree, that is disqualifying, not a
// deduction.
const MARKET_KINDS = [
  ["podium",   /\bpodium\b|\btop[ -]?3\b|\btop[ -]?three\b/],
  ["pole",     /\bpole\b|\bqualifying\b|\bqualifier\b/],
  ["fastest",  /\bfastest[ -]lap\b/],
  ["points",   /\bpoints\b|\bscore(?:s|d)?\b/],
  ["margin",   /\bmargin\b|\bspread\b|\bhandicap\b/],
  ["total",    /\bover\/under\b|\bo\/u\b|\btotal\b/],
  ["winner",   /\bwinner\b|\bwins?\b|\bwin\b|\bchampion\b|\bmoneyline\b/],
]

// Titles are noisy in venue-specific ways: Polymarket prefixes the sport, Kalshi
// spells out "Grand Prix" where Polymarket writes "GP", and everyone disagrees
// about punctuation. These collapse the differences that are purely cosmetic.
const TITLE_ALIASES = [
  [/\bgrand prix\b/g, "gp"],
  [/\bf1\b|\bformula 1\b|\bformula one\b/g, "f1"],
  [/\bpresidential\b/g, "president"],
  [/\bchampionships?\b/g, "champion"],
  [/\bworld series\b/g, "worldseries"],
]

function normalizeTitle(text) {
  let s = String(text || "").toLowerCase()
  for (const [re, to] of TITLE_ALIASES) s = s.replace(re, to)
  return s
    .replace(/[‘’“”]/g, "")   // smart quotes
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

// Four-digit years and bare two-digit ticker years are date signal, not title
// signal — they are scored by dateScore() instead, where being one day off can
// be told apart from being one year off.
function titleTokens(text) {
  return normalizeTitle(text)
    .split(" ")
    .filter(t => t && t.length > 1 && !STOPWORDS.has(t) && !/^(19|20)\d{2}$/.test(t))
}

function marketKind(text) {
  const s = normalizeTitle(text)
  for (const [kind, re] of MARKET_KINDS) if (re.test(s)) return kind
  return null
}

// Outcome names that say nothing about which event this is. Every binary market
// ever written has a Yes and a No, so counting those as agreement made two
// unrelated questions look like the same one.
const GENERIC_OUTCOMES = new Set([
  "yes", "no", "other", "field", "tie", "draw", "none", "neither", "any",
])

// A person is the same person whether a venue lists "Andrea Kimi Antonelli",
// "Kimi Antonelli" or "Antonelli", so outcomes are compared on their last
// significant word as well as in full.
function outcomeKey(name) {
  const tokens = normalizeTitle(name).split(" ").filter(Boolean)
  if (!tokens.length) return ""
  return tokens[tokens.length - 1]
}

function outcomeKeys(names) {
  const set = new Set()
  for (const n of names || []) {
    const key = outcomeKey(n)
    if (key && key.length > 1 && !GENERIC_OUTCOMES.has(key)) set.add(key)
  }
  return set
}

// Pulls YYYY-MM-DD out of anything a venue calls a date: an ISO timestamp, a
// Polymarket slug tail (…-2026-09-13-w), a Gemini ticker tail (…-20260913), or
// a Kalshi ticker's two-digit year suffix, which is too coarse to use as a day
// and is deliberately not returned.
function extractDate(...sources) {
  for (const raw of sources) {
    const s = String(raw || "")
    if (!s) continue
    const iso = s.match(/(\d{4})-(\d{2})-(\d{2})/)
    if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`
    const packed = s.match(/(?:^|[^0-9])(20\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(?:[^0-9]|$)/)
    if (packed) return `${packed[1]}-${packed[2]}-${packed[3]}`
  }
  return ""
}

function daysApart(a, b) {
  if (!a || !b) return null
  const ta = Date.parse(a + "T00:00:00Z")
  const tb = Date.parse(b + "T00:00:00Z")
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null
  return Math.abs(ta - tb) / 86400000
}

// Overlap as a share of the *smaller* set. Venues list different numbers of
// outcomes for the same event — Kalshi carries every driver, Polymarket often
// carries the top few and an "Other" — so dividing by the union would punish a
// correct match for the other venue's completeness.
function overlapRatio(a, b) {
  if (!a.size || !b.size) return null
  let hits = 0
  for (const x of a) if (b.has(x)) hits++
  return hits / Math.min(a.size, b.size)
}

const WEIGHTS = { title: 0.3, date: 0.35, outcomes: 0.35 }

// source / candidate: { title, subtitle, date, outcomes: string[] }
// Returns { score: 0..1, confidence, reasons: string[], disqualified: string|null }.
function scoreMatch(source, candidate) {
  const reasons = []
  const srcTitle = [source.title, source.subtitle].filter(Boolean).join(" ")
  const canTitle = [candidate.title, candidate.subtitle].filter(Boolean).join(" ")

  const srcTokens = new Set(titleTokens(srcTitle))
  const canTokens = new Set(titleTokens(canTitle))
  const titleScore = overlapRatio(srcTokens, canTokens)

  const srcOutcomes = outcomeKeys(source.outcomes)
  const canOutcomes = outcomeKeys(candidate.outcomes)
  const outcomeScore = overlapRatio(srcOutcomes, canOutcomes)

  const gap = daysApart(source.date, candidate.date)
  let dateScore = null
  if (gap != null) {
    // A day's slack absorbs timezone skew between a UTC close time and a local
    // event date; beyond that the venues are describing different occasions.
    dateScore = gap === 0 ? 1 : gap <= 1 ? 0.7 : gap <= 3 ? 0.25 : 0
  }

  // Nothing but a shared date is not evidence. Hundreds of unrelated events
  // close on any given day, so a candidate that agrees on neither the words nor
  // the outcomes is rejected outright rather than scored.
  if (!titleScore && !outcomeScore) {
    return { score: 0, confidence: "none", reasons: [], disqualified: "nothing in common but the date" }
  }

  // Two listings of the same event name some of the same competitors. When both
  // sides publish real names and not one of them is shared, they are different
  // events — and this is the only signal strong enough to say so, because the
  // words in the titles are not.
  //
  // The 2026 Spanish Grand Prix is why. "Grand Prix Cycliste de Montreal 2026:
  // Winner" finishes the same day, shares "grand", "prix" and "winner", and
  // scored LIKELY against an F1 race on nothing but that. Its riders and the
  // drivers have no name in common, which settles it instantly.
  const NAMES_NEEDED = 2
  if (srcOutcomes.size >= NAMES_NEEDED && canOutcomes.size >= NAMES_NEEDED && outcomeScore === 0) {
    return {
      score: 0,
      confidence: "none",
      reasons: [],
      disqualified: "no competitor or outcome in common",
    }
  }

  const srcKind = marketKind(srcTitle)
  const canKind = marketKind(canTitle)
  if (srcKind && canKind && srcKind !== canKind) {
    return {
      score: 0,
      confidence: "none",
      reasons: [],
      disqualified: `different market type (${srcKind} vs ${canKind})`,
    }
  }

  // Only the signals that both sides actually published get a vote; their
  // weights are renormalized so a venue that publishes no outcome list is not
  // scored as if its outcomes disagreed.
  let total = 0
  let weightUsed = 0
  if (titleScore != null)   { total += titleScore   * WEIGHTS.title;    weightUsed += WEIGHTS.title }
  if (dateScore != null)    { total += dateScore    * WEIGHTS.date;     weightUsed += WEIGHTS.date }
  if (outcomeScore != null) { total += outcomeScore * WEIGHTS.outcomes; weightUsed += WEIGHTS.outcomes }
  let score = weightUsed ? total / weightUsed : 0

  // A date the two venues disagree about by more than a few days caps the
  // result at "weak" no matter how well everything else lines up. Every F1 race
  // of the season shares a driver list and most of its title, so outcome and
  // title overlap alone rank last week's race as a confident match for this
  // week's. The cap rather than a rejection is deliberate: long-horizon markets
  // (an election, a season award) genuinely carry different end dates on
  // different venues, and those stay visible for the user to judge.
  let capped = false
  if (dateScore === 0 && score > 0.45) { score = 0.45; capped = true }

  if (dateScore === 1) reasons.push("same close date")
  else if (dateScore != null && dateScore >= 0.7) reasons.push("close dates within a day")
  else if (capped) reasons.push(`close dates ${Math.round(gap)} days apart — check this is the same event`)
  if (outcomeScore != null && outcomeScore >= 0.6) reasons.push(`${Math.round(outcomeScore * 100)}% of outcomes match`)
  if (titleScore != null && titleScore >= 0.5) reasons.push("titles agree")
  if (srcKind && srcKind === canKind) reasons.push(`both are ${srcKind} markets`)

  return { score, confidence: confidenceFor(score), reasons, disqualified: null }
}

// The labels the UI shows. "Strong" is the only band the user should be able to
// accept without reading the candidate's title; the lower two exist so a
// near-miss is visible rather than silently dropped, which is what makes this
// safe to put one click away from a comparison.
function confidenceFor(score) {
  if (score >= 0.75) return "strong"
  if (score >= 0.5)  return "likely"
  if (score >= 0.3)  return "weak"
  return "none"
}

// Ranks candidates for one platform, drops everything below "weak", and keeps
// at most `limit`. Ties break toward the candidate with more outcome data,
// which is the one a comparison can actually say something about.
function rankCandidates(source, candidates, limit = 3) {
  return (candidates || [])
    .map(c => ({ ...c, ...scoreMatch(source, c) }))
    .filter(c => c.confidence !== "none")
    .sort((a, b) => (b.score - a.score) || ((b.outcomes || []).length - (a.outcomes || []).length))
    .slice(0, limit)
}

// Tokens as the venues actually spell them — the same filtering as
// titleTokens() but without the aliases. Aliasing is right for *comparing* two
// titles and wrong for *searching* a third party's: collapsing "grand prix" to
// "gp" made the query literally unfindable, because the listing being looked
// for says "Grand Prix" and contains no "gp" at all.
function searchTokens(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[‘’“”]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    // Two-character tokens are noise ("de", "la") unless they carry a digit, in
    // which case they are a series code — "f1", "t20" — and among the most
    // findable words there are.
    .filter(t => t && !STOPWORDS.has(t) && !/^(19|20)\d{2}$/.test(t) &&
      (t.length > 2 || (t.length === 2 && /\d/.test(t))))
}

// The words worth sending to another venue's search box, each meant to be sent
// as its OWN query rather than joined into one.
//
// This is the whole retrieval problem in one function, and it was got wrong the
// first time. The premise of cross-venue matching is that the venues describe
// the same event in *different words* — and the first implementation searched
// the other venue using the source venue's words, joined with spaces. Looking
// for the 2026 Spanish Grand Prix on Gemini sent "spanish winner gp" at a
// listing titled "Madrid Grand Prix Winner": no shared word, no result, nothing
// for the scorer to rank. The feature reported "no matching event found" for an
// event that was right there.
//
// Sent one at a time, "grand" finds it. The words a venue does not share are
// harmless — they return nothing — and the words it does share are enough,
// because the scoring that follows is what decides whether a hit is really the
// same event. Retrieval should be broad and scoring strict, not both strict.
//
// An outcome name goes in the list too. Competitor names are the one vocabulary
// that genuinely does not vary between venues: every book listing this race
// lists Verstappen.
function searchTerms(source, max = 5) {
  const fromTitle = searchTokens([source.title, source.subtitle].filter(Boolean).join(" "))
    .sort((a, b) => b.length - a.length)

  // The leading outcome, by the name the source venue gave it.
  const leadOutcome = (source.outcomes || [])
    .map(o => outcomeKey(o))
    .filter(k => k && k.length > 3)[0]

  // The competitor's name goes FIRST, not last. Sorted in behind four title
  // words it was being cut off by the cap on exactly the markets it helps most
  // — the ones with long descriptive titles.
  const out = []
  const seen = new Set()
  for (const t of [leadOutcome, ...fromTitle]) {
    if (!t || seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out.slice(0, max)
}

const api = {
  normalizeTitle, titleTokens, marketKind, outcomeKey, outcomeKeys,
  extractDate, daysApart, overlapRatio, scoreMatch, confidenceFor,
  rankCandidates, searchTerms, searchTokens, STOPWORDS, GENERIC_OUTCOMES,
}

module.exports = api
