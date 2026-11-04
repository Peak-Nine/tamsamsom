const test = require("node:test");
const assert = require("node:assert/strict");
const { startApp, browser, fakeAnthropic, textReply } = require("./helpers");

test("anyone with the link gets the tool, with an anonymous visitor cookie and no indexing", async (t) => {
  const app = await startApp();
  t.after(app.close);
  const go = browser(app.base);

  const page = await go("/");
  assert.equal(page.status, 200);
  assert.match(await page.text(), /\/assets\/runtime\.js/);
  assert.match(page.headers.get("set-cookie"), /^tss_visitor=[A-Za-z0-9_-]{16,}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+$/);
  assert.equal(page.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.equal(await (await go("/robots.txt")).text(), "User-agent: *\nDisallow: /\n");

  // The same visitor keeps the same id; a new browser gets a new one.
  const me1 = (await go.json("GET", "/api/me")).json;
  const me2 = (await go.json("GET", "/api/me")).json;
  const other = (await browser(app.base).json("GET", "/api/me")).json;
  assert.equal(me1.id, me2.id);
  assert.notEqual(me1.id, other.id);
  assert.equal(me1.name, "Visitor");

  assert.equal((await go("/login")).status, 404);
  assert.equal((await go("/assets/vendor/jspdf.umd.min.js")).status, 200);
});

test("documents: set, merge-update, list in order, and the update-then-set fallback", async (t) => {
  const app = await startApp();
  t.after(app.close);
  const go = browser(app.base);

  assert.equal((await go.json("PUT", "/api/doc", { path: "projects/p1", data: { id: "p1", name: "Bikes", updatedAt: 1 }, mode: "set" })).status, 200);
  await go.json("PUT", "/api/doc", { path: "projects/p2", data: { id: "p2", name: "Food", updatedAt: 5 }, mode: "set" });
  await go.json("PUT", "/api/doc", { path: "projects/p1", data: { summary: { defs: 2 } }, mode: "update" });

  const doc = await go.json("GET", "/api/doc?path=projects/p1");
  assert.deepEqual(doc.json, { exists: true, data: { id: "p1", name: "Bikes", updatedAt: 1, summary: { defs: 2 } } });
  assert.deepEqual((await go.json("GET", "/api/doc?path=projects/nope")).json, { exists: false, data: null });

  // update() on a missing document fails with invalid_argument, so the tool falls back to set().
  const miss = await go.json("PUT", "/api/doc", { path: "projects/p1/parts/intro", data: { a: 1 }, mode: "update" });
  assert.equal(miss.status, 400);
  assert.equal(miss.json.error.code, "invalid_argument");

  // One shared list: a different visitor sees both projects.
  const list = await browser(app.base).json("GET", "/api/collection?path=projects&orderBy=updatedAt&dir=desc&limit=100");
  assert.deepEqual(list.json.docs.map((d) => d.id), ["p2", "p1"]);

  // Paths outside the projects tree, or malformed ones, are refused.
  assert.equal((await go.json("PUT", "/api/doc", { path: "users/x", data: {}, mode: "set" })).status, 403);
  assert.equal((await go.json("GET", "/api/doc?path=projects/../x")).status, 400);
  assert.equal((await go.json("PUT", "/api/doc", { path: "projects/big", data: { x: "a".repeat(1000 * 1024) }, mode: "set" })).status, 400);
});

test("too many saves from one address in a minute are slowed down", async (t) => {
  const app = await startApp({ env: { WRITE_LIMIT_PER_MINUTE: "3" } });
  t.after(app.close);
  const go = browser(app.base);
  for (let i = 0; i < 3; i++) assert.equal((await go.json("PUT", "/api/doc", { path: `projects/q${i}`, data: { i }, mode: "set" })).status, 200);
  const r = await go.json("PUT", "/api/doc", { path: "projects/q9", data: {}, mode: "set" });
  assert.equal(r.status, 429);
  assert.equal(r.json.error.code, "rate_limited");
});

test("live sync: changes stream to every open browser, presence per project", async (t) => {
  const app = await startApp();
  t.after(app.close);
  const a = browser(app.base);
  const b = browser(app.base);

  const listen = async (go) => {
    const res = await go("/api/events");
    const reader = res.body.getReader();
    const events = [];
    (async () => {
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read().catch(() => ({ done: true }));
        if (done) return;
        buf += dec.decode(value);
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (chunk.startsWith("data: ")) events.push(JSON.parse(chunk.slice(6)));
        }
      }
    })();
    return { events, stop: () => reader.cancel().catch(() => {}) };
  };
  const sa = await listen(a);
  const sb = await listen(b);
  t.after(() => (sa.stop(), sb.stop()));

  await a.json("PUT", "/api/doc", { path: "projects/p9", data: { id: "p9", updatedAt: 1 }, mode: "set" });
  await a.json("PUT", "/api/doc", { path: "projects/p9/markets/TAM", data: { a: 1 }, mode: "set" });
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(sb.events.filter((e) => e.type === "doc").map((e) => e.path), ["projects/p9", "projects/p9/markets/TAM"]);
  assert.equal(sb.events[1].parent, "projects/p9/markets");

  // Both open project p9; each sees the other, not themselves.
  await a.json("POST", "/api/room", { room: "p-p9", presence: { view: "compute" } });
  await b.json("POST", "/api/room", { room: "p-p9", presence: { view: "summary" } });
  await new Promise((r) => setTimeout(r, 100));
  const lastPeers = (s) => s.events.filter((e) => e.type === "peers").pop();
  assert.deepEqual(lastPeers(sa).peers.map((p) => p.presence.view), ["summary"]);
  assert.deepEqual(lastPeers(sb).peers.map((p) => p.presence.view), ["compute"]);
  assert.equal(lastPeers(sa).peers[0].presence.name, "Visitor");
  assert.equal((await a.json("POST", "/api/room", { room: "../x", presence: {} })).status, 400);
});

test("AI: models per level, refusals, broken JSON", async (t) => {
  let next = () => textReply('{"ideas":["a","b"]}');
  const client = fakeAnthropic((req) => next(req));
  const app = await startApp({ aiClient: client });
  t.after(app.close);
  const go = browser(app.base);

  const r1 = await go.json("POST", "/api/ai/json", { prompt: "Give ideas. Reply with JSON only.", tier: "default" });
  assert.deepEqual(r1.json, { result: { ideas: ["a", "b"] } });
  assert.equal(client.calls[0].model, "claude-opus-5-5");
  assert.equal(client.calls[0].fallbacks, "default");
  assert.equal(client.calls[0].messages[0].content, "Give ideas. Reply with JSON only.");

  await go.json("POST", "/api/ai/json", { prompt: "Quick one", tier: "quick" });
  assert.equal(client.calls[1].model, "claude-haiku-5-5");
  assert.equal(client.calls[1].output_config.effort, "low");

  next = () => textReply("Sorry, that is not JSON");
  const bad = await go.json("POST", "/api/ai/json", { prompt: "x" });
  assert.equal(bad.status, 422);
  assert.equal(bad.json.error.code, "invalid_json");
  assert.equal(bad.json.error.text, "Sorry, that is not JSON");

  next = () => ({ model: "fake", stop_reason: "refusal", content: [], usage: {} });
  assert.equal((await go.json("POST", "/api/ai/json", { prompt: "x" })).json.error.code, "refused");

  const usage = await app.pool.query("SELECT kind FROM ai_usage ORDER BY id");
  assert.deepEqual(usage.rows.map((r) => r.kind), ["json", "json-quick", "json", "json"]);
});

test("AI: the daily caps, per visitor and for the whole site", async (t) => {
  const app = await startApp({ env: { AI_DAILY_LIMIT_TOTAL: "3", AI_DAILY_LIMIT: "2" } });
  t.after(app.close);
  const a = browser(app.base);
  const b = browser(app.base);

  assert.equal((await a.json("POST", "/api/ai/json", { prompt: "1" })).status, 200);
  assert.equal((await a.json("POST", "/api/ai/json", { prompt: "2" })).status, 200);
  const own = await a.json("POST", "/api/ai/json", { prompt: "3" });
  assert.equal(own.json.error.code, "rate_limited");
  assert.match(own.json.error.message, /today's AI limit \(2 requests\)/);

  // Same network address, new cookie: the per-address cap still applies.
  assert.equal((await b.json("POST", "/api/ai/json", { prompt: "4" })).json.error.code, "rate_limited");

  // Usage from elsewhere counts towards the site total.
  await app.pool.query("INSERT INTO ai_usage (visitor, ip, kind, model, created_at) VALUES ('x', '10.9.9.9', 'json', 'm', $1)", [Date.now()]);
  const site = await a.json("POST", "/api/web/search", { q: "anything" });
  assert.match(site.json.error.message, /today's limit for this site \(3 requests\)/);
});

test("web research: search through Anthropic, read pages on the server", async (t) => {
  const client = fakeAnthropic((req) => {
    assert.deepEqual(req.tools, [{ type: "web_search_20260209", name: "web_search", max_uses: 1 }]);
    return {
      model: "fake",
      stop_reason: "end_turn",
      usage: { input_tokens: 100, output_tokens: 3, server_tool_use: { web_search_requests: 1 } },
      content: [
        { type: "web_search_tool_result", content: [{ type: "web_search_result", url: "https://cbs.example.nl/bikes", title: "Bikes in NL", encrypted_content: "x", page_age: null }] },
        { type: "text", text: "done" },
      ],
    };
  });
  const pages = {
    "https://cbs.example.nl/bikes": () => new Response("<title>Bikes in NL</title><p>There are 23 million bikes in the Netherlands.</p>", { headers: { "content-type": "text/html" } }),
    "https://moved.example.org/": () => new Response("", { status: 301, headers: { location: "http://10.0.0.1/admin" } }),
  };
  const webFetch = async (url) => (pages[url] ? pages[url]() : new Response("nope", { status: 404, headers: { "content-type": "text/html" } }));
  const lookup = async (host) => [{ address: host === "10.0.0.1" ? "10.0.0.1" : "93.184.216.34" }];
  const app = await startApp({ aiClient: client, webFetch, lookup, env: { READ_LIMIT_PER_HOUR: "5" } });
  t.after(app.close);
  const go = browser(app.base);

  const s = await go.json("POST", "/api/web/search", { q: "number of bikes Netherlands" });
  assert.deepEqual(s.json.results, [{ title: "Bikes in NL", url: "https://cbs.example.nl/bikes", domain: "cbs.example.nl", snippet: "", pdf: false }]);
  assert.match(client.calls[0].messages[0].content, /Query: number of bikes Netherlands/);
  assert.equal((await app.pool.query("SELECT searches FROM ai_usage")).rows[0].searches, 1);

  const page = await go.json("POST", "/api/web/read", { url: "https://cbs.example.nl/bikes" });
  assert.deepEqual(page.json, { title: "Bikes in NL", text: "There are 23 million bikes in the Netherlands." });

  // A redirect to an internal address is refused, as is a direct one.
  assert.equal((await go.json("POST", "/api/web/read", { url: "https://moved.example.org/" })).json.error.code, "tool_error");
  assert.match((await go.json("POST", "/api/web/read", { url: "http://127.0.0.1:80/" })).json.error.message, /not reachable/);
  assert.equal((await go.json("POST", "/api/web/read", { url: "https://cbs.example.nl/missing" })).json.error.code, "bad_page");
  // Fifth read this hour is the last one allowed.
  await go.json("POST", "/api/web/read", { url: "https://cbs.example.nl/bikes" });
  assert.equal((await go.json("POST", "/api/web/read", { url: "https://cbs.example.nl/bikes" })).status, 429);
});

test("requests from another site are refused", async (t) => {
  const app = await startApp();
  t.after(app.close);
  const go = browser(app.base);
  const r = await go("/api/doc", { method: "PUT", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: JSON.stringify({ path: "projects/x", data: {}, mode: "set" }) });
  assert.equal(r.status, 403);
});

test("without an API key the site works and the AI says it isn't set up", async (t) => {
  const app = await startApp({ aiClient: null, env: { ANTHROPIC_API_KEY: "" } });
  t.after(app.close);
  const go = browser(app.base);
  const r = await go.json("POST", "/api/ai/json", { prompt: "x" });
  assert.equal(r.json.error.code, "sampling_disabled");
  assert.equal((await go("/")).status, 200);
});
