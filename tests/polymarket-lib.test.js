const test = require("node:test")
const assert = require("node:assert/strict")

const { fetchEventBySlug, venueFor, isSafeSlug } = require("../lib/polymarket")

const ok = (payload) => ({ status: 200, body: JSON.stringify(payload) })

test("a .us link is recognised as the US venue", () => {
  assert.equal(venueFor("https://polymarket.us/sports/f1/f1-thsgp-2026-09-13-w"), "us")
  assert.equal(venueFor("https://polymarket.com/event/f1-spanish-gp"), "com")
  assert.equal(venueFor("us"), "us")
})

test("a slug that does not exist is a 404 that names it, not a 502", () => {
  // gamma answers 200 with [] for an unknown slug. Calling that a bad gateway
  // told readers the exchange was down and had them retry a doomed request.
  assert.equal(isSafeSlug("f1-thsgp-2026-09-13-w"), true)
  return fetchEventBySlug("no-such-event", "com", { fetch: async () => ok([]) })
    .then((res) => {
      assert.equal(res.status, 404)
      assert.match(res.error, /No Polymarket event with slug "no-such-event"/)
    })
})

test("a .us slug is looked up on .com, and no guessed host is probed", async () => {
  // gamma-api.polymarket.us was tried in production and does not resolve.
  // Keeping it in the list spends a failed DNS lookup per request and tells the
  // reader nothing, so a .us link checks the one host that actually answers.
  const tried = []
  const res = await fetchEventBySlug("shared-slug", "us", {
    fetch: async (url) => {
      tried.push(new URL(url).hostname)
      return ok([{ title: "Found on .com" }])
    },
  })
  assert.deepEqual(tried, ["gamma-api.polymarket.com"])
  assert.equal(res.status, 200)
  assert.match(res.body, /Found on \.com/)
})

test("a .us slug missing from both venues says the venues are separate", async () => {
  const res = await fetchEventBySlug("us-only-event", "us", { fetch: async () => ok([]) })
  assert.equal(res.status, 404)
  assert.match(res.error, /separate US-regulated exchange/)
})

test("an unparseable body is still a 502 — that one really is the upstream", async () => {
  const res = await fetchEventBySlug("mangled", "com", {
    fetch: async () => ({ status: 200, body: "<html>maintenance</html>" }),
  })
  assert.equal(res.status, 502)
  assert.match(res.error, /Invalid response/)
})

test("a transport failure on one host does not mask the other's answer", async () => {
  const res = await fetchEventBySlug("flaky", "us", {
    fetch: async (url) => {
      if (url.includes("polymarket.us")) throw new Error("ECONNRESET")
      return ok([{ title: "Still here" }])
    },
  })
  assert.equal(res.status, 200)
})

test("a slug with path or query characters in it is rejected before any request", async () => {
  let called = false
  const res = await fetchEventBySlug("../admin?x=1", "com", { fetch: async () => { called = true; return ok([]) } })
  assert.equal(res.status, 400)
  assert.equal(called, false)
})

test("a timeout is a 504, not a 502 — the reader is told to retry, not that the market is gone", async () => {
  const res = await fetchEventBySlug("slow", "com", {
    fetch: async () => { throw new Error("timeout") },
  })
  assert.equal(res.status, 504)
  assert.match(res.error, /timed out/)
})

test("a .us link is told the venue is unsupported, not that its link is wrong", async () => {
  // The reader pasted a perfectly valid market URL. "Event not found" invites
  // them to check it and paste it again; the truth is that no amount of
  // re-pasting will work, and the card that can find the event is one analyze
  // away on any other venue.
  const res = await fetchEventBySlug("f1-thsgp-2026-09-13-w", "us", { fetch: async () => ok([]) })
  assert.equal(res.status, 404)
  assert.match(res.error, /aren't supported yet/)
  assert.match(res.error, /no public API/)
  assert.match(res.error, /cross-platform match card/)
  assert.ok(!/gamma-api/.test(res.error), "the host trail was for diagnosing the guess, which is now settled")
})

test("the .com venue's not-found stays short — there is no second host to report on", async () => {
  const res = await fetchEventBySlug("nope", "com", { fetch: async () => ok([]) })
  assert.equal(res.error, 'No Polymarket event with slug "nope"')
})
